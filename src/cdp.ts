import WebSocket from 'ws';
import * as cp from 'child_process';
import * as path from 'path';

export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export const DEFAULT_PORT = 9333; // avoid colliding with common 9222 usage

// CURSOR_EXE is monkey-patched by cursor.init() from config; the default keeps
// standalone verify scripts working without a config file.
export let CURSOR_EXE = path.join('C:', 'Program Files', 'cursor', 'Cursor.exe');

export function setCursorExe(exe: string): void {
  CURSOR_EXE = exe;
}

export interface ProbeResult {
  ok: boolean;
  port: number;
  version: unknown | null;
  targets: Record<string, unknown>[];
  pagesProbed: Record<string, unknown>[];
  errors: string[];
  launchPid?: number;
}

export async function httpJson(url: string, timeout = 6.0): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeout * 1000));
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function waitCdp(port: number, timeoutS = 60.0): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const v = await httpJson(`http://127.0.0.1:${port}/json/version`, 1.5);
      return (v as Record<string, unknown>) || {};
    } catch (e) {
      lastErr = String(e);
      await sleep(0.5);
    }
  }
  throw new Error(`CDP not reachable on ${port}: ${lastErr}`);
}

export async function listTargets(port: number): Promise<Record<string, unknown>[]> {
  const v = await httpJson(`http://127.0.0.1:${port}/json/list`, 3.0);
  return (v as Record<string, unknown>[]) || [];
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

export class CdpSession {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(wsUrl: string, maxSize = 16 * 1024 * 1024) {
    this.ws = new WebSocket(wsUrl, { maxPayload: maxSize });
  }

  async connect(timeoutS = 10.0): Promise<void> {
    if (!this.ws) throw new Error('closed');
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutS * 1000);
      ws.once('open', () => {
        clearTimeout(timer);
        ws.on('message', (data) => this.onMessage(data));
        ws.on('close', () => this.onClose());
        ws.on('error', () => this.onClose());
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const id = typeof parsed['id'] === 'number' ? parsed['id'] : -1;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (parsed['error'] !== undefined) {
      p.reject(new Error(JSON.stringify(parsed['error'])));
    } else {
      p.resolve(parsed['result']);
    }
  }

  private onClose(): void {
    for (const [, p] of this.pending) {
      p.reject(new Error('CDP closed'));
    }
    this.pending.clear();
  }

  async call(method: string, params?: Record<string, unknown>, timeout = 15.0): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    this.msgId += 1;
    const msgId = this.msgId;
    const payload = { id: msgId, method, ...(params ? { params } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(msgId, { resolve, reject });
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout * 1000);
      this.ws!.send(JSON.stringify(payload), (err) => {
        clearTimeout(timer);
        if (err) {
          this.pending.delete(msgId);
          reject(err);
        }
      });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as Record<string, unknown>;
    if (result['exceptionDetails']) {
      throw new Error(JSON.stringify(result['exceptionDetails']));
    }
    return (result['result'] as Record<string, unknown> | undefined)?.['value'];
  }

  async close(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }
}

// --------------------------------------------------------------- PROBE_JS ----
export const PROBE_JS = String.raw`
(() => {
  const textOf = (el) => ((el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '') + '').trim().slice(0, 120);
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
  };

  const inputSelectors = [
    '.aislash-editor-input',
    '[data-lexical-editor="true"][contenteditable="true"]',
    '[contenteditable="true"][aria-label*="Chat" i]',
    '[contenteditable="true"][aria-label*="Ask" i]',
    'textarea[placeholder*="Ask" i]',
    'div[contenteditable="true"].ProseMirror',
    '[data-testid="chat-input"]',
    '.composer-input textarea',
    'div.monaco-mouse-cursor-text',
  ];

  const dismissText = /^(not now|maybe later|no thanks|skip|dismiss|close|later|取消|稍后再说|以后再说|关闭|跳过|暂不|不用了)$/i;
  const dismissLoose = /(not now|maybe later|no thanks|dismiss|skip for now|remind me later|稍后再说|以后再说|暂不|关闭|跳过)/i;
  const upgradeLoose = /(upgrade|subscribe|buy|try pro|learn more|enable|install|升级|订阅|购买|了解更多)/i;
  const newChatLoose = /(new chat|new agent|新对话|新建聊天|new composer)/i;

  const inputs = [];
  for (const sel of inputSelectors) {
    document.querySelectorAll(sel).forEach((el, idx) => {
      const r = rectOf(el);
      if (!r.visible) return;
      inputs.push({
        kind: 'input_candidate',
        selector: sel,
        index: idx,
        tag: el.tagName,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder'),
        contentEditable: el.getAttribute('contenteditable'),
        className: (el.className || '').toString().slice(0, 120),
        rect: r,
      });
    });
  }

  document.querySelectorAll('[contenteditable="true"]').forEach((el, idx) => {
    const r = rectOf(el);
    if (!r.visible || r.y < window.innerHeight * 0.35) return;
    if (r.w < 200 || r.h < 20) return;
    inputs.push({
      kind: 'input_contenteditable_bottom',
      selector: '[contenteditable="true"]',
      index: idx,
      tag: el.tagName,
      ariaLabel: el.getAttribute('aria-label'),
      className: (el.className || '').toString().slice(0, 120),
      rect: r,
    });
  });

  const buttons = [];
  document.querySelectorAll('button, [role="button"], a').forEach((el, idx) => {
    const t = textOf(el);
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const blob = \`\${t} \${aria} \${title}\`.trim();
    if (!blob) return;
    const r = rectOf(el);
    if (!r.visible) return;
    const isDismiss = dismissText.test(blob) || dismissLoose.test(blob);
    const isUpgrade = upgradeLoose.test(blob);
    const isNewChat = newChatLoose.test(blob) || /new chat/i.test(aria);
    if (!(isDismiss || isUpgrade || isNewChat)) return;
    buttons.push({
      kind: isDismiss ? 'dismiss' : isNewChat ? 'new_chat' : 'upgrade_like',
      text: t || aria || title,
      ariaLabel: aria,
      tag: el.tagName,
      className: (el.className || '').toString().slice(0, 120),
      rect: r,
      index: idx,
    });
  });

  const overlays = [];
  document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .shadow-xl').forEach((el, idx) => {
    const r = rectOf(el);
    if (!r.visible || r.w < 120 || r.h < 80) return;
    overlays.push({
      kind: 'overlay',
      role: el.getAttribute('role'),
      text: textOf(el).slice(0, 200),
      className: (el.className || '').toString().slice(0, 120),
      rect: r,
      index: idx,
    });
  });

  const uniq = [];
  const seen = new Set();
  for (const item of inputs) {
    const key = \`\${item.rect.x},\${item.rect.y},\${item.rect.w},\${item.rect.h},\${item.kind}\`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(item);
  }

  return {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    inputCount: uniq.length,
    inputs: uniq.slice(0, 20),
    buttons: buttons.slice(0, 40),
    overlays: overlays.slice(0, 20),
    bodyTextSample: (document.body?.innerText || '').slice(0, 300),
  };
})()
`;

// ------------------------------------------------------- FOCUS_AND_TYPE_JS ----
export const FOCUS_AND_TYPE_JS_TEMPLATE = String.raw`
(async (payload) => {
  const { selector, text, submit } = payload;
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: 'selector_not_found', selector };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  el.focus();
  el.click();
  return { ok: true, selector, tag: el.tagName, focused: document.activeElement === el };
})(PAYLOAD)
`;

export interface LaunchOpts {
  port: number;
  profile: string;
  workspace?: string | null;
}

export function launchCursor(opts: LaunchOpts): cp.ChildProcess {
  const args = [
    CURSOR_EXE,
    `--remote-debugging-port=${opts.port}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${opts.profile}`,
    '--disable-workspace-trust',
    '--new-window',
  ];
  if (opts.workspace) {
    args.push(opts.workspace);
  }
  return cp.spawn(args[0], args.slice(1), {
    stdio: 'ignore',
    windowsHide: true,
    detached: true, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP 近似：脱离父进程组，不受 Ctrl-C 影响
    shell: false,
  });
}

export function isWorkbenchTarget(t: Record<string, unknown>): boolean {
  const url = ((t['url'] as string) || '').toLowerCase();
  const typ = t['type'];
  if (typ !== 'page' && typ !== 'other') return false;
  if (url.includes('devtools://')) return false;
  if (url.includes('extension') && !url.includes('vscode-file')) return false;
  if (url.includes('vscode-file://') || url.includes('workbench') || url.includes('cursor') || url.startsWith('vscode-webview')) return true;
  if (typ === 'page' && t['webSocketDebuggerUrl']) return true;
  return false;
}

export interface ProbePage {
  targetId?: string;
  title?: string;
  url?: string;
  type?: string;
  probe?: Record<string, unknown>;
}

export async function probePages(port: number, maxPages = 6): Promise<[ProbePage[], string[]]> {
  const targets = await listTargets(port);
  const pages: ProbePage[] = [];
  const errors: string[] = [];
  let candidates = targets.filter(
    (t) => t['webSocketDebuggerUrl'] && isWorkbenchTarget(t),
  );
  if (!candidates.length) {
    candidates = targets.filter(
      (t) => t['type'] === 'page' && t['webSocketDebuggerUrl'],
    );
  }

  for (const t of candidates.slice(0, maxPages)) {
    const wsUrl = t['webSocketDebuggerUrl'] as string;
    const session = new CdpSession(wsUrl);
    try {
      await session.connect();
      await session.call('Runtime.enable');
      let probe: unknown = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          probe = await session.evaluate(PROBE_JS);
          const p = probe as Record<string, unknown> | null;
          if (p && (Number(p['inputCount'] || 0) > 0 || attempt >= 3)) break;
        } catch (e) {
          probe = { error: String(e) };
        }
        await sleep(1.0);
      }
      pages.push({
        targetId: t['id'] as string,
        title: t['title'] as string,
        url: t['url'] as string,
        type: t['type'] as string,
        probe: (probe as Record<string, unknown>) || undefined,
      });
    } catch (e) {
      errors.push(`probe ${String(t['id'])}: ${String(e)}`);
    } finally {
      await session.close();
    }
  }
  return [pages, errors];
}

export async function findTarget(port: number, page: ProbePage): Promise<Record<string, unknown> | null> {
  const targets = await listTargets(port);
  return targets.find((t) => t['id'] === page.targetId) || null;
}

/** Pick the page with the most input candidates (the real workbench). */
export async function bestPage(port: number): Promise<[ProbePage | null, string[]]> {
  const [pages, errors] = await probePages(port);
  if (!pages.length) return [null, errors];
  pages.sort((a, b) => {
    const ia = Number((a.probe || {})['inputCount'] || 0);
    const ib = Number((b.probe || {})['inputCount'] || 0);
    return ib - ia;
  });
  return [pages[0], errors];
}

/** Open a CDP session to a specific page (Runtime.enable already called). */
export async function sessionFor(port: number, page: ProbePage): Promise<CdpSession> {
  const target = await findTarget(port, page);
  if (!target || !target['webSocketDebuggerUrl']) {
    throw new Error('CDP target missing');
  }
  const s = new CdpSession(target['webSocketDebuggerUrl'] as string);
  await s.connect();
  await s.call('Runtime.enable');
  return s;
}

export interface FocusTypeResult {
  ok: boolean;
  reason?: string;
  selector?: string;
  focus?: unknown;
  typedCheck?: unknown;
  submitted?: boolean;
}

export async function tryFocusAndType(
  port: number,
  page: ProbePage,
  text: string,
  submit: boolean,
): Promise<FocusTypeResult> {
  const target = await findTarget(port, page);
  if (!target || !target['webSocketDebuggerUrl']) {
    return { ok: false, reason: 'target_missing' };
  }
  const probe = page.probe || {};
  const inputs = (probe['inputs'] as Record<string, unknown>[]) || [];
  if (!inputs.length) {
    return { ok: false, reason: 'no_input_candidates' };
  }

  let preferred: Record<string, unknown> | undefined;
  for (const item of inputs) {
    const sel = String(item['selector'] || '');
    if (
      sel.includes('aislash') ||
      sel.includes('lexical') ||
      String(item['ariaLabel'] || '').includes('Ask') ||
      item['kind'] === 'input_candidate'
    ) {
      preferred = item;
      break;
    }
  }
  if (!preferred) preferred = inputs[0];
  const selector = String(preferred['selector']);

  const session = new CdpSession(target['webSocketDebuggerUrl'] as string);
  try {
    await session.connect();
    await session.call('Runtime.enable');
    await session.call('Input.setIgnoreInputEvents', { ignore: false });
    const focusJs = FOCUS_AND_TYPE_JS_TEMPLATE.replace(
      'PAYLOAD',
      JSON.stringify({ selector, text, submit }),
    );
    const focusResult = await session.evaluate(focusJs);
    await session.call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await session.call('Input.insertText', { text });
    const typedCheck = await session.evaluate(String.raw`
      (() => {
        const a = document.activeElement;
        return {
          tag: a && a.tagName,
          text: ((a && (a.innerText || a.value)) || '').slice(0, 200),
          contentEditable: a && a.getAttribute('contenteditable'),
        };
      })()
    `);
    if (submit) {
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    return {
      ok: true,
      selector,
      focus: focusResult,
      typedCheck,
      submitted: submit,
    };
  } finally {
    await session.close();
  }
}

export async function tryDismiss(port: number, page: ProbePage): Promise<Record<string, unknown>> {
  const probe = page.probe || {};
  const dismiss = ((probe['buttons'] as Record<string, unknown>[]) || []).filter(
    (b) => b['kind'] === 'dismiss',
  );
  if (!dismiss.length) {
    return { ok: false, reason: 'no_dismiss_button' };
  }
  const target = await findTarget(port, page);
  if (!target) {
    return { ok: false, reason: 'target_missing' };
  }
  const btn = dismiss[0];
  const session = new CdpSession(target['webSocketDebuggerUrl'] as string);
  try {
    await session.connect();
    await session.call('Runtime.enable');
    const want = String(btn['text'] || btn['ariaLabel'] || '');
    const js = String.raw`(() => {
      const want = ${JSON.stringify(want).toLowerCase()};
      const nodes = [...document.querySelectorAll('button, [role="button"], a')];
      const el = nodes.find(n => ((n.innerText||n.getAttribute('aria-label')||'')+'').trim().toLowerCase() === want)
        || nodes.find(n => /not now|maybe later|no thanks|skip|稍后再说|暂不|关闭/i.test(((n.innerText||n.getAttribute('aria-label')||'')+'')));
      if (!el) return { ok:false, reason:'not_found' };
      el.click();
      return { ok:true, text: ((el.innerText||el.getAttribute('aria-label')||'')+'').trim().slice(0,80) };
    })()`;
    const result = (await session.evaluate(js)) as Record<string, unknown> | null;
    return { ok: Boolean(result && result['ok']), detail: result, candidate: btn };
  } finally {
    await session.close();
  }
}
