import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import { bestPage, sessionFor, sleep, ProbePage } from './cdp';

export type Json = Record<string, unknown>;

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

export async function waitDomLoggedIn(port: number, timeoutS: number): Promise<Json> {
  const deadline = Date.now() + timeoutS * 1000;
  let last: Json = {};
  while (Date.now() < deadline) {
    let page: ProbePage | null = null;
    try {
      const got = await bestPage(port);
      page = got[0];
    } catch (e) {
      // CDP HTTP 瞬时无响应（Cursor 启动繁忙期 fetch 可能 abort）：容错重试，不抛给上层
      console.log(`[auth-dom] transient bestPage error: ${String(e)}`);
      await sleep(1.5);
      continue;
    }
    if (!page) {
      await sleep(1.5);
      continue;
    }
    const s = await sessionFor(port, page);
    try {
      last = ((await s.evaluate(AUTH_GATE_JS)) as Json) || {};
    } catch (e) {
      // evaluate 也可能瞬时失败（页面仍在加载）：记录并重试
      last = { _error: String(e) };
      await sleep(1.5);
      continue;
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
