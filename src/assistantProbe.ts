import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import { detectAssistantExe, USER_CONFIG_DIR } from './config';
import { httpJson, sleep } from './cdp';

/** Elevated probe: relaunch the LoginAssistant with --remote-debugging-port and
 * dump its real DOM (page text + buttons) to runstate/assistant_probe.json.
 *
 * Run elevated (UAC), e.g. from an elevated shell.
 */

export const PORT = 9355;
// 输出写到外置 runstate（%APPDATA%\curloop\runstate），不写包内目录
export const OUT = path.join(USER_CONFIG_DIR, 'runstate', 'assistant_probe.json');

function resolveExe(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exe' && i + 1 < argv.length) {
      return path.resolve(argv[i + 1]);
    }
  }
  const found = detectAssistantExe();
  if (!found) {
    console.error(
      '未找到 CursorLoginAssistant-*.exe（已扫描 Desktop/Downloads），请用 --exe <路径> 指定',
    );
    process.exitCode = 2;
    throw new Error('assistant exe not found');
  }
  return found;
}

function killAssistant(exeName: string): void {
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name = '${exeName}'" | ForEach-Object {\n` +
    '  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}\n' +
    '}\n';
  try {
    cp.execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '""')}"`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  sleep(2);
}

async function waitCdp(timeoutS = 40.0): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutS * 1000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      return (await httpJson(`http://127.0.0.1:${PORT}/json/version`, 2.0)) as Record<string, unknown>;
    } catch (e) {
      last = String(e);
      await sleep(1.0);
    }
  }
  throw new Error(`CDP not up on ${PORT}: ${last}`);
}

const DUMP_JS = `(() => {
  const out = { title: document.title, url: location.href, body: (document.body ? document.body.innerText : '').slice(0, 3000), buttons: [] };
  document.querySelectorAll('button, [role="button"], a, [class*="btn" i]').forEach((el, i) => {
    const t = ((el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '') + '').trim();
    if (t && t.length < 60) out.buttons.push({ i, tag: el.tagName, text: t, cls: (el.className||'').toString().slice(0,40) });
  });
  return out;
})()`;

async function dumpPage(wsUrl: string, title: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 16 * 1024 * 1024 });
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('dump timeout'));
    }, 10_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(
        JSON.stringify({
          id: 2,
          method: 'Runtime.evaluate',
          params: { expression: DUMP_JS, returnByValue: true, awaitPromise: true },
        }),
      );
    });
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg['id'] === 2) {
        clearTimeout(timer);
        const result = (msg['result'] as Record<string, unknown> | undefined) || {};
        const inner = (result['result'] as Record<string, unknown> | undefined) || {};
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(inner['value']);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  }).catch((e) => ({ error: String(e), title }));
}

export async function main(argv: string[]): Promise<number> {
  const exe = resolveExe(argv);
  const report: Record<string, unknown> = {
    ok: false,
    launched_pid: null,
    cdp: null,
    pages: [],
    error: null,
  };
  try {
    killAssistant(path.basename(exe));
    const proc = cp.spawn(exe, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    report['launched_pid'] = proc.pid;
    const version = await waitCdp(45.0);
    report['cdp'] = version['Browser'];
    const targets = (await httpJson(`http://127.0.0.1:${PORT}/json/list`, 3.0)) as Record<string, unknown>[];
    for (const t of targets || []) {
      if (t['type'] !== 'page') continue;
      const wsUrl = t['webSocketDebuggerUrl'];
      if (!wsUrl) continue;
      const dom = await dumpPage(String(wsUrl), String(t['title'] ?? ''));
      (report['pages'] as unknown[]).push({
        title: t['title'],
        url: String(t['url'] ?? '').slice(0, 120),
        dom,
      });
    }
    report['ok'] = true;
  } catch (e) {
    report['error'] = String(e);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf-8');
  console.log(JSON.stringify(report, null, 2).slice(0, 2000));
  return 0;
}
