import * as cp from 'child_process';
import * as cdp from './cdp';
import { bestPage, CdpSession, httpJson, launchCursor, sessionFor, sleep, waitCdp } from './cdp';
import type { Config } from './config';
import {
  REPLY_JS,
  buildLimitJs,
  buildLogoutJs,
  classifyLimit,
  CompletionTracker,
  LimitSample,
  ReplySample,
} from './detection';
import type { CompletionState } from './detection';
import {
  stateDbPath,
  readAuthFromDb,
  waitDomLoggedIn,
} from './auth';
import { setCursorExe } from './cdp';

// --------------------------------------------------------------- lifecycle ----
export async function cdpUp(port: number): Promise<boolean> {
  try {
    const v = await httpJson(`http://127.0.0.1:${port}/json/version`, 1.5);
    return Boolean(v);
  } catch {
    return false;
  }
}

export async function cdpVersion(port: number): Promise<string | null> {
  try {
    const v = (await httpJson(`http://127.0.0.1:${port}/json/version`, 1.5)) as Record<string, unknown>;
    return String(v['Browser'] || '') || null;
  } catch {
    return null;
  }
}

export async function killAllCursor(waitS = 2.0): Promise<void> {
  const ps = `
Get-CimInstance Win32_Process -Filter "Name = 'Cursor.exe'" | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
`;
  await new Promise<void>((resolve) => {
    cp.exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '""')}"`, { encoding: 'utf8' }, () => resolve());
  });
  await sleep(waitS);
}

export async function launch(port: number, profile: string, workspace: string | null): Promise<cp.ChildProcess> {
  return launchCursor({ port, profile, workspace });
}

// -------------------------------------------------------------------- auth ----
export function authInfo(cfg: Config) {
  return readAuthFromDb(stateDbPath(cfg.cursor.profile));
}

export function authFp(cfg: Config): string | null {
  const info = authInfo(cfg);
  if (info.hasAccessToken) return info.accessFp;
  return null;
}

export async function waitTokenChange(
  cfg: Config,
  oldFp: string | null,
  timeoutS: number,
  poll = 2.0,
): Promise<[boolean, Record<string, unknown>]> {
  const deadline = Date.now() + timeoutS * 1000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = { ...authInfo(cfg) };
    const fp = last['accessFp'] as string | null;
    const changed = Boolean(fp) && fp !== oldFp;
    console.log(
      `[auth] fp=${fp} changed=${changed} email=${last['email']} token=${last['hasAccessToken'] ? 'yes' : 'no'}`,
    );
    if (changed) return [true, last];
    await sleep(poll);
  }
  return [false, last];
}

// -------------------------------------------------------------- dismiss ----
export const DISMISS_JS = String.raw`
(() => {
  const textOf = (el) => ((el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '') + '').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const safeRe = /^(not now|later|maybe later|no thanks|skip|skip this version|dismiss|close|ok|okay|got it|gotcha|i understand|cancel|取消|稍后|以后再说|稍后再说|暂不|不用了|跳过|关闭|跳过此版本|了解|知道了|好的|确定)$/i;
  const safeLoose = /(not now|maybe later|skip this version|remind me later|got it|i understand|dismiss|skip for now|稍后|以后再说|暂不|跳过|关闭|了解|知道了|好的|确定)/i;
  const dangerous = /update|upgrade|restart|buy|purchase|subscribe|upgrade to pro|订阅|升级|立即更新|更新并重启/i;
  const modals = [...document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], .modal, .cursor-modal-container, .cursor-modal-backing, .cursor-modal-interior'
  )].filter(visible);
  let clicked = null;
  for (const modal of modals) {
    for (const el of [...modal.querySelectorAll('button, [role="button"], a')].filter(visible)) {
      const t = textOf(el);
      if (!t || dangerous.test(t)) continue;
      if (safeRe.test(t) || safeLoose.test(t)) { el.click(); clicked = t.slice(0, 60); break; }
    }
    if (clicked) break;
    for (const el of modal.querySelectorAll('div, span, a')) {
      if (el.children.length > 0) continue;
      if (!visible(el)) continue;
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 60 || dangerous.test(t)) continue;
      if (safeRe.test(t)) { el.click(); clicked = t.slice(0, 60); break; }
    }
    if (clicked) break;
    const x = [...modal.querySelectorAll(
      '[aria-label="Close" i], [aria-label="Dismiss" i], [title="Close"], button[class*="close" i], .codicon-close, .cursor-modal-dismiss, .codicon-x'
    )].filter(visible)[0];
    if (x) { x.click(); clicked = 'x-close'; break; }
  }
  return { ok: !!clicked, clicked, modalCount: modals.length };
})()
`;

export async function dismissAll(port: number): Promise<Record<string, unknown>> {
  const [page, errors] = await bestPage(port);
  if (!page) return { ok: false, reason: 'no workbench page', errors };
  const s = await sessionFor(port, page);
  try {
    return ((await s.evaluate(DISMISS_JS)) as Record<string, unknown>) || { ok: false, reason: 'no result' };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    await s.close();
  }
}

export async function dismissUntilClear(port: number, timeoutS = 30.0, poll = 2.0): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutS * 1000;
  let attempts = 0;
  let last: Record<string, unknown> = { ok: false, reason: 'no attempt' };
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      last = await dismissAll(port);
    } catch (e) {
      last = { ok: false, reason: String(e) };
    }
    if (Number(last['modalCount'] ?? 1) === 0) break;
    await sleep(poll);
  }
  last['attempts'] = attempts;
  last['timedOut'] = Number(last['modalCount'] ?? 1) !== 0;
  return last;
}

// ------------------------------------------------------------------- send ----
export async function sendPrompt(cfg: Config, prompt: string, submit = true): Promise<Record<string, unknown>> {
  const [page, errors] = await bestPage(cfg.cursor.port);
  if (!page) return { ok: false, error: 'no workbench page', errors };
  const dismiss = await dismissUntilClear(cfg.cursor.port, 8.0, 1.0);
  const typed = await cdp.tryFocusAndType(cfg.cursor.port, page, prompt, submit);
  return { ok: Boolean(typed.ok), dismiss, type: typed, page, errors };
}

export async function clearComposer(cfg: Config): Promise<Record<string, unknown>> {
  const [page, errors] = await bestPage(cfg.cursor.port);
  if (!page) return { ok: false, error: 'no workbench page', errors };
  const typed = await cdp.tryFocusAndType(cfg.cursor.port, page, '', false);
  return { ok: Boolean(typed.ok), type: typed };
}

// ------------------------------------------------------------------- poll ----
export async function pollReply(
  cfg: Config,
  tracker: CompletionTracker,
  prevLimitHits: Set<string>,
): Promise<Record<string, unknown>> {
  const [page, errors] = await bestPage(cfg.cursor.port);
  if (!page) return { state: 'no_page', errors };

  let s: CdpSession | null = null;
  let reply: ReplySample = {};
  let limitSample: LimitSample = {};
  let logout: Record<string, unknown> = {};
  try {
    s = await sessionFor(cfg.cursor.port, page);
    reply = ((await s.evaluate(REPLY_JS)) as ReplySample) || {};
    limitSample = ((await s.evaluate(buildLimitJs(cfg.detection))) as LimitSample) || {};
    logout = ((await s.evaluate(buildLogoutJs(cfg.detection))) as Record<string, unknown>) || {};
  } catch (e) {
    if (s) await s.close();
    return { state: 'cdp_error', errors: [String(e)], reply: {}, limitSample: {}, logout: {} };
  }
  await s.close();

  const [st, detail] = tracker.update(reply);
  let state: CompletionState | 'limit' = st;
  const [isLimit] = classifyLimit(limitSample, prevLimitHits, cfg.detection.limitRequireRecent);
  if (isLimit) state = 'limit';
  if (logout['loggedOut'] && state !== 'done') state = 'logged_out';

  return { state, detail, reply, limitSample, logout, errors };
}

export async function evaluateJs(port: number, js: string): Promise<Record<string, unknown>> {
  const [page] = await bestPage(port);
  if (!page) return { error: 'no workbench page' };
  const s = await sessionFor(port, page);
  try {
    return ((await s.evaluate(js)) as Record<string, unknown>) || {};
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------ new chat ----
/** 点击「New Chat / 新对话」：线程轮转（thread.rotate_every_tasks）用。 */
export const NEW_CHAT_JS = String.raw`
(() => {
  const textOf = (el) => ((el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '') + '').trim();
  const re = /(new chat|new agent|start new|新对话|新建聊天|新聊天|新建对话)/i;
  const nodes = [...document.querySelectorAll('button, [role="button"], a, [role="tab"], [aria-label]')];
  const el = nodes.find((n) => re.test(textOf(n)))
    || nodes.find((n) => /new chat/i.test(n.getAttribute('aria-label') || ''));
  if (!el) return { ok: false, reason: 'new_chat_not_found' };
  el.click();
  return { ok: true, text: textOf(el).slice(0, 40) };
})()
`;

export async function clickNewChat(port: number): Promise<Record<string, unknown>> {
  return evaluateJs(port, NEW_CHAT_JS);
}

export const INJECT_LIMIT_NODE_JS = String.raw`
(() => {
  const d = document.createElement('div');
  d.id = 'harness-limit-sim';
  d.innerText = "You've reached your usage limit. Please upgrade or wait.";
  d.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:#c00;color:#fff;padding:10px;font-size:16px;';
  document.body.appendChild(d);
  return true;
})()
`;

export async function injectLimitNode(port: number): Promise<Record<string, unknown>> {
  return evaluateJs(port, INJECT_LIMIT_NODE_JS);
}

// ---------------------------------------------------------------- ensure ----
export async function ensureReady(
  cfg: Config,
  workspace: string,
  relaunch = true,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ok: false, launched: false, errors: [] };
  const port = cfg.cursor.port;

  if (!(await cdpUp(port))) {
    if (!relaunch) {
      (result['errors'] as string[]).push('CDP not reachable');
      return result;
    }
    result['launched'] = true;
    await killAllCursor();
    try {
      const proc = await launch(port, cfg.cursor.profile, workspace);
      result['launchPid'] = proc.pid;
      const version = await waitCdp(port, cfg.timeouts.cdpReadyS);
      result['cdpVersion'] = version['Browser'];
      console.log(`[cdp] ready: ${result['cdpVersion']}`);
    } catch (e) {
      (result['errors'] as string[]).push(`launch: ${String(e)}`);
      return result;
    }
  } else {
    result['cdpVersion'] = await cdpVersion(port);
  }

  const dom = await waitDomResilient(cfg);
  const domSlim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dom)) {
    if (k !== 'page') domSlim[k] = v;
  }
  result['dom'] = domSlim;
  if (dom['_cdpDown']) {
    (result['errors'] as string[]).push('CDP went down while waiting for workbench DOM');
    return result;
  }
  if (dom['loggedOut'] || !dom['inputVisible']) {
    (result['errors'] as string[]).push('not logged in or chat input not visible');
    return result;
  }
  result['dismiss'] = await dismissUntilClear(cfg.cursor.port, 30.0, 2.0);
  result['ok'] = true;
  result['page'] = dom['page'];
  return result;
}

async function waitDomResilient(cfg: Config): Promise<Record<string, unknown>> {
  const port = cfg.cursor.port;
  const deadline = Date.now() + cfg.timeouts.domReadyS * 1000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      last = await waitDomLoggedIn(port, Math.max(5.0, (deadline - Date.now()) / 1000));
      if (last['inputVisible'] && !last['loggedOut']) return last;
      break;
    } catch (e) {
      console.log(`[dom] transient error, retrying: ${String(e)}`);
      last = { _error: String(e) };
      if (!(await cdpUp(port))) {
        last['_cdpDown'] = true;
        return last;
      }
      await sleep(2);
    }
  }
  return last;
}

// ------------------------------------------------------------------- init ----
export function init(cfg: Config): void {
  setCursorExe(cfg.cursor.exe);
}
