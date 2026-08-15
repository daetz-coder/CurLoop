import { DatabaseSync } from 'node:sqlite';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ProbePage, bestPage, launchCursor, sessionFor, sleep, tryDismiss, tryFocusAndType, waitCdp } from './cdp';

export type Json = Record<string, unknown>;

export const ROAMING_CURSOR = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'Cursor');

export function stateDbPath(userDataDir: string): string {
  return path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
}

export interface AuthInfo {
  dbExists: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  email: string | null;
  accessFp: string | null;
  error?: string;
}

/** 只读窥探 Cursor auth keys，绝不打印完整 token。 */
export function readAuthFromDb(dbPath: string): AuthInfo {
  const out: AuthInfo = {
    dbExists: fs.existsSync(dbPath),
    hasAccessToken: false,
    hasRefreshToken: false,
    email: null,
    accessFp: null,
  };
  if (!fs.existsSync(dbPath)) return out;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  } catch (e) {
    out.error = String(e);
    return out;
  }
  try {
    const wanted = [
      'cursorAuth/accessToken',
      'cursorAuth/refreshToken',
      'cursorAuth/cachedEmail',
      'cursorAuth/cachedSignUpType',
    ];
    const rows: Record<string, string> = {};
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    for (const key of wanted) {
      try {
        const row = stmt.get(key) as { value?: unknown } | undefined;
        if (row && row.value) rows[key] = String(row.value);
      } catch {
        /* table missing on first boot */
      }
    }
    const token = rows['cursorAuth/accessToken'] || '';
    out.hasAccessToken = Boolean(token) && token.startsWith('eyJ');
    out.hasRefreshToken = Boolean(rows['cursorAuth/refreshToken']);
    out.email = rows['cursorAuth/cachedEmail'] ?? null;
    if (token) {
      out.accessFp = `${token.slice(0, 12)}…${token.slice(-8)}(len=${token.length})`;
    }
    return out;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

export async function waitAuthInDb(userDataDir: string, timeoutS: number, poll = 1.0): Promise<AuthInfo> {
  const db = stateDbPath(userDataDir);
  const deadline = Date.now() + timeoutS * 1000;
  let last: AuthInfo = { dbExists: false, hasAccessToken: false, hasRefreshToken: false, email: null, accessFp: null };
  while (Date.now() < deadline) {
    last = readAuthFromDb(db);
    console.log(`[auth-db] exists=${last.dbExists} token=${last.hasAccessToken} email=${last.email}`);
    if (last.hasAccessToken) return last;
    await sleep(poll);
  }
  return last;
}

export const AUTH_GATE_JS = String.raw`
(() => {
  const text = ((document.body && document.body.innerText) || '');
  const lower = text.toLowerCase();
  const loggedOut =
    /require you to be logged in/i.test(text) ||
    /sign up/i.test(text) && /log in/i.test(lower) && /cursor.?s ai features/i.test(lower) ||
    /需要登录/.test(text);
  const inputs = document.querySelectorAll(
    '.aislash-editor-input, [data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"]'
  );
  let inputVisible = false;
  inputs.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 80 && r.height > 12) inputVisible = true;
  });
  return {
    loggedOut,
    inputVisible,
    title: document.title,
    sampleTail: text.slice(-500),
  };
})()
`;

export async function killCursorForProfile(userDataDir: string): Promise<void> {
  const needle = userDataDir.toLowerCase();
  const ps = `
$needle = '${needle.replace(/'/g, "''")}'.ToLower()
Get-CimInstance Win32_Process -Filter "Name = 'Cursor.exe'" | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine.ToLower().Contains($needle)) {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}
`;
  await new Promise<void>((resolve) => {
    cp.exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '""')}"`, { encoding: 'utf8' }, () => resolve());
  });
  await sleep(1.5);
}

export async function waitDomLoggedIn(port: number, timeoutS: number): Promise<Json> {
  const deadline = Date.now() + timeoutS * 1000;
  let last: Json = {};
  while (Date.now() < deadline) {
    const [page] = await bestPage(port);
    if (!page) {
      await sleep(1.5);
      continue;
    }
    const s = await sessionFor(port, page);
    try {
      last = ((await s.evaluate(AUTH_GATE_JS)) as Json) || {};
    } finally {
      await s.close();
    }
    console.log(`[auth-dom] loggedOut=${last['loggedOut']} input=${last['inputVisible']} title=${JSON.stringify(last['title'])}`);
    if (last['inputVisible'] && !last['loggedOut']) {
      last['page'] = page;
      return last;
    }
    if (last['inputVisible'] && !String(last['sampleTail'] || '').toLowerCase().includes('require you to be logged in')) {
      last['page'] = page;
      return last;
    }
    await sleep(2.0);
  }
  return last;
}

export const RESUME_REPLY_JS = String.raw`
(() => {
  const text = ((document.body && document.body.innerText) || '');
  const generating = /stop generating|停止|generating|thinking/i.test(text);
  const pairs = [...document.querySelectorAll(
    '.composer-human-ai-pair-container, .anysphere-markdown-container-root, [data-message-kind]'
  )].map(el => ((el.innerText || '') + '').trim().slice(0, 500));
  return {
    generating,
    pairCount: pairs.length,
    pairs: pairs.slice(-6),
    hasMarker: text.includes('HARNESS_RESUME_OK'),
    loggedOut: /require you to be logged in/i.test(text),
    tail: text.slice(-800),
  };
})()
`;

export async function runConversation(
  port: number,
  prompt: string,
  timeoutS = 180.0,
): Promise<Json> {
  const [page, errors] = await bestPage(port);
  const result: Json = { ok: false, errors, steps: [] };
  if (!page) {
    (result['errors'] as string[]).push('no workbench page');
    return result;
  }

  const dismiss = await tryDismiss(port, page);
  (result['steps'] as Json[]).push({ dismiss });

  const typed = await tryFocusAndType(port, page, prompt, true);
  (result['steps'] as Json[]).push({ send: typed });
  if (!typed.ok) {
    (result['errors'] as string[]).push('send failed');
    return result;
  }

  const deadline = Date.now() + timeoutS * 1000;
  let last: Json | null = null;
  let sawGen = false;
  while (Date.now() < deadline) {
    await sleep(2.0);
    const [page2] = await bestPage(port);
    if (!page2) continue;
    const s = await sessionFor(port, page2);
    try {
      last = ((await s.evaluate(RESUME_REPLY_JS)) as Json) || {};
    } finally {
      await s.close();
    }
    if (last['generating']) sawGen = true;
    console.log(
      `[reply] gen=${last['generating']} pairs=${last['pairCount']} marker=${last['hasMarker']} loggedOut=${last['loggedOut']}`,
    );
    if (last['loggedOut']) {
      (result['errors'] as string[]).push('logged out during chat');
      break;
    }
    if (last['hasMarker'] && (sawGen || Number(last['pairCount'] || 0) > 0)) {
      const tail = String(last['tail'] || '');
      if (
        (tail.match(/HARNESS_RESUME_OK/g) || []).length >= 1 &&
        (sawGen || (tail.includes('Reply with exactly') && tail.lastIndexOf('HARNESS_RESUME_OK') > tail.lastIndexOf('Reply with exactly')))
      ) {
        result['ok'] = true;
        break;
      }
    }
    if (sawGen && !last['generating'] && Number(last['pairCount'] || 0) > 0) {
      result['ok'] = true;
      break;
    }
  }
  (result['steps'] as Json[]).push({ after: last, sawGenerating: sawGen });
  return result;
}

export interface ResumeArgs {
  port?: number;
  profile?: string;
  workspace?: string;
  waitAuth?: number;
  waitDom?: number;
  relaunch?: boolean;
  prompt?: string;
  out?: string;
  skipChat?: boolean;
}

export async function resumeMain(args: ResumeArgs): Promise<number> {
  const port = args.port ?? 9333;
  const profile = args.profile ?? path.resolve(__dirname, '..', '.harness-profile');
  const workspace = args.workspace ?? path.resolve(__dirname, '..');
  const report: Json = { ok: false, profile, port, phases: {} };

  console.log(`[..] waiting for auth in profile DB: ${stateDbPath(profile)}`);
  const auth = await waitAuthInDb(profile, args.waitAuth ?? 180.0);
  report['phases'] = { ...(report['phases'] as Json), authDb: auth };
  if (!auth.hasAccessToken) {
    const roaming = readAuthFromDb(stateDbPath(ROAMING_CURSOR));
    report['phases'] = {
      ...(report['phases'] as Json),
      authDbRoaming: { dbExists: roaming.dbExists, hasAccessToken: roaming.hasAccessToken, email: roaming.email, accessFp: roaming.accessFp },
    };
    console.log('[fail] No accessToken in harness profile yet.');
    writeReport(report, args.out);
    return 2;
  }

  let cdpUp = false;
  try {
    await import('node:url');
    const { httpJson } = await import('./cdp');
    await httpJson(`http://127.0.0.1:${port}/json/version`, 1.5);
    cdpUp = true;
  } catch {
    cdpUp = false;
  }

  if (args.relaunch || !cdpUp) {
    console.log('[..] relaunching Cursor with CDP');
    await killCursorForProfile(profile);
    if (!fs.existsSync(process.env.CURSOR_HARNESS_CURSOR_EXE || path.join('C:', 'Program Files', 'cursor', 'Cursor.exe'))) {
      console.log(`[fail] missing Cursor.exe`);
      return 2;
    }
    const proc = launchCursor({ port, profile, workspace });
    report['phases'] = { ...(report['phases'] as Json), launchPid: proc.pid };
    try {
      const version = await waitCdp(port, 90);
      report['phases'] = { ...(report['phases'] as Json), cdpVersion: version['Browser'] };
      console.log(`[ok] CDP ready: ${version['Browser']}`);
    } catch (e) {
      report['phases'] = { ...(report['phases'] as Json), cdpError: String(e) };
      writeReport(report, args.out);
      console.log(`[fail] ${String(e)}`);
      return 2;
    }
  } else {
    console.log(`[ok] CDP already up on ${port}`);
  }

  console.log('[..] waiting for DOM logged-in / chat input');
  const dom = await waitDomLoggedIn(port, args.waitDom ?? 120.0);
  const domSlim = { ...dom };
  delete (domSlim as { page?: ProbePage }).page;
  report['phases'] = { ...(report['phases'] as Json), authDom: domSlim };
  if (!dom['inputVisible'] || dom['loggedOut']) {
    console.log('[fail] Chat UI still gated / no input');
    writeReport(report, args.out);
    return 1;
  }

  if (args.skipChat) {
    report['ok'] = true;
    writeReport(report, args.out);
    console.log('[ok] auth+CDP ready (chat skipped)');
    return 0;
  }

  console.log('[..] sending prompt and waiting for reply');
  const chat = await runConversation(port, args.prompt ?? 'Reply with exactly: HARNESS_RESUME_OK. No other text.');
  report['phases'] = { ...(report['phases'] as Json), chat };
  report['ok'] = Boolean(chat['ok']);
  writeReport(report, args.out);
  console.log(JSON.stringify({ ok: report['ok'] }));
  console.log('=>', args.out);
  return report['ok'] ? 0 : 1;
}

function writeReport(report: Json, out?: string): void {
  const target = out || path.resolve(__dirname, '..', 'verify-resume.json');
  try {
    fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf-8');
  } catch {
    /* ignore */
  }
}
