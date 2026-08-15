import type { DetectionConfig } from './config';

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------- limit ----
export const LIMIT_JS = String.raw`
(() => {
  const EN = %(en)s;
  const CN = %(cn)s;
  const SEL = '[role="dialog"], [aria-modal="true"], [class*="banner" i], ' +
             '[class*="toast" i], [class*="notification" i], [class*="limit" i], ' +
             '.modal, .shadow-xl';
  const txt = (el) => ((el.innerText || el.textContent || '') + '').trim();
  const scoped = [...document.querySelectorAll(SEL)].map(txt).filter(Boolean).join('\n');
  const body = (document.body && document.body.innerText) || '';
  const bodyTail = body.slice(-2000);
  const hay = scoped + '\n' + bodyTail;
  const low = hay.toLowerCase();
  const hits = [];
  for (const k of EN) if (low.includes(k)) hits.push(k);
  for (const k of CN) if (hay.includes(k)) hits.push(k);
  const hard = /(usage limit|reached (your )?limit|limit reached|rate limit|too many requests|out of requests|slow pool|已达上限|达到上限|次数已达|请求次数已|额度已用)/i.test(hay);
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    .map(txt).filter(Boolean).slice(-3);
  return {
    hits: [...new Set(hits)],
    hard,
    dialogs: dialogs.slice(-2),
    tail: bodyTail.slice(-400),
  };
})()
`.replace('%(en)s', '__LIMIT_EN__').replace('%(cn)s', '__LIMIT_CN__');

export function buildLimitJs(cfg: DetectionConfig): string {
  return LIMIT_JS
    .replace('__LIMIT_EN__', JSON.stringify(cfg.limitKeywordsEn))
    .replace('__LIMIT_CN__', JSON.stringify(cfg.limitKeywordsCn));
}

export interface LimitSample extends Json {
  hits?: unknown;
  hard?: unknown;
  dialogs?: unknown;
  tail?: unknown;
}

export function classifyLimit(
  sample: LimitSample,
  prevHits: Set<string>,
  requireRecent: boolean,
): [boolean, string | null] {
  const hits = new Set<string>((sample.hits as string[]) || []);
  if (sample.hard) return [true, `hard: ${[...hits].sort().slice(0, 6).join(',')}`];
  if (hits.size >= 2) {
    if (requireRecent && prevHits.size && isSubset(hits, prevHits)) {
      return [false, null];
    }
    return [true, `multi: ${[...hits].sort().slice(0, 6).join(',')}`];
  }
  return [false, null];
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ------------------------------------------------------------ completion ----
export const REPLY_JS = String.raw`
(() => {
  const body = (document.body && document.body.innerText) || '';
  const hasStop = !!document.querySelector(
    'button[aria-label*="stop" i], button[aria-label*="停止" i], button[aria-label*="cancel" i], button[aria-label*="取消" i], button[title*="stop" i], button[title*="停止" i], [class*="stop-generating" i], [class*="stop" i][role="button"]'
  );
  const read = (el) => ((el.innerText || el.textContent || '') + '').trim();
  const assistant = [...document.querySelectorAll(
    '[data-message-role="assistant"], [data-message-kind*="assistant" i], [data-message-role*="assistant" i], .anysphere-markdown-container-root'
  )].map(read).filter(Boolean);
  const pairs = [...document.querySelectorAll(
    '.composer-human-ai-pair-container, [data-message-kind], [data-message-role]'
  )].map(read).filter(Boolean);
  const all = assistant.length ? assistant : pairs;
  const last = all[all.length - 1] || '';
  const composer = document.querySelector('.aislash-editor-input');
  const composerText = (composer && ((composer.innerText || composer.textContent || '') + '').trim()) || '';
  const thinking = /(thinking|generating|working on|planning|正在思考|思考中|生成中|运行中|正在运行|正在执行|正在生成|正在读取|正在编辑|正在写入|正在搜索|正在规划|正在准备)/i.test(
    all.slice(-3).join('\n') || ''
  );
  const toolActivity = /(running|executing|searching|reading|editing|writing|planning|applying|running terminal|正在运行|正在执行|正在搜索|正在读取|正在编辑|正在写入|正在规划|正在应用|运行中|执行中|处理中|规划中|读取中|准备中)/i.test(last);
  const toolRunning = /(running|executing|processing|working|reading|planning|searching|writing|applying|exploring|inspecting|waiting for|正在运行|正在执行|正在读取|正在规划|正在搜索|正在写入|正在应用|正在检查|正在等待|执行中|运行中|读取中|规划中|搜索中|处理中|进行中|准备中|等待中)/i.test(
    (all.slice(-3).join('\n') || '')
  );
  const toolCardCount = document.querySelectorAll('.ui-tool-call-card, [class*="tool-call-card" i]').length;
  const cardHeaders = [...document.querySelectorAll('.ui-tool-call-card__header, .ui-shell-tool-call__card')]
    .map((e) => (e.innerText || '').trim())
    .filter(Boolean);
  const lastCard = cardHeaders[cardHeaders.length - 1] || '';
  const toolWaiting = /(waiting|awaiting|in progress|请稍候|等待中|执行中|运行中|处理中|进行中|准备中|正在)/i.test(
    cardHeaders.slice(-3).join(' ')
  )
    || /^(wait|run|exec|正在|等待|执行)/i.test(lastCard);
  let queuedCount = 0;
  for (const el of document.querySelectorAll('div, span')) {
    if (el.children.length > 0) continue;
    const t = ((el.innerText || el.textContent || '') + '').trim();
    const m = /^(\d+)\s*queued$/i.exec(t);
    if (m) {
      queuedCount = parseInt(m[1], 10);
      break;
    }
  }
  const hasQueued = queuedCount > 0;
  return {
    hasStop,
    thinking,
    toolActivity,
    toolRunning,
    toolWaiting,
    queuedCount,
    hasQueued,
    toolCardCount,
    composerText,
    busy: !!(hasStop || thinking || toolActivity || toolRunning || toolWaiting || hasQueued || composerText),
    lastLen: last.length,
    lastTail: last.slice(-120),
    lastFull: last.slice(-400),
    pairCount: pairs.length,
    loggedOut: /(require you to be logged in|已退出登录|重新登录|会话已过期|session expired)/i.test(body),
  };
})()
`;

export interface ReplySample extends Json {
  hasStop?: unknown;
  thinking?: unknown;
  toolActivity?: unknown;
  toolRunning?: unknown;
  toolWaiting?: unknown;
  hasQueued?: unknown;
  composerText?: unknown;
  lastLen?: unknown;
  lastTail?: unknown;
  lastFull?: unknown;
  pairCount?: unknown;
  toolCardCount?: unknown;
  loggedOut?: unknown;
  busy?: unknown;
}

export type CompletionState = 'busy' | 'done' | 'waiting' | 'hard_timeout' | 'logged_out';

export class CompletionTracker {
  stablePolls: number;
  minElapsed: number;
  hardTimeout: number;
  pollInterval: number;
  private stable = 0;
  private lastLen = -1;
  private lastTail: string | null = null;
  private lastPairs = -1;
  private lastToolCards = -1;
  start: number;
  private history: Array<[number, number]> = [];

  constructor(
    stablePolls = 4,
    minElapsed = 10.0,
    hardTimeout = 900.0,
    pollInterval = 3.0,
  ) {
    this.stablePolls = Math.max(2, stablePolls);
    this.minElapsed = minElapsed;
    this.hardTimeout = hardTimeout;
    this.pollInterval = pollInterval;
    this.start = Date.now() / 1000;
  }

  /** Return (state, detail). */
  update(s: ReplySample): [CompletionState, string] {
    const elapsed = Date.now() / 1000 - this.start;
    this.history.push([elapsed, Number(s.lastLen || 0)]);
    if (this.history.length > 20) this.history.shift();

    if (s.loggedOut) {
      this.stable = 0;
      return ['logged_out', 'logged out mid-run'];
    }

    if (s.busy) {
      this.stable = 0;
      this.lastLen = -1;
      this.lastTail = null;
      const flags = (['hasStop', 'thinking', 'toolActivity', 'toolRunning', 'toolWaiting', 'hasQueued', 'composerText'] as const)
        .filter((k) => s[k])
        .join('+');
      return ['busy', `agent busy ${elapsed.toFixed(0)}s (${flags || '?'})`];
    }

    const lastLen = Number(s.lastLen || 0);
    const tail = String(s.lastTail || '');

    const pairs = Number(s.pairCount || 0);
    if (this.lastPairs >= 0 && pairs !== this.lastPairs) this.stable = 0;
    this.lastPairs = pairs;

    const cards = Number(s.toolCardCount || 0);
    if (this.lastToolCards >= 0 && cards !== this.lastToolCards) this.stable = 0;
    this.lastToolCards = cards;

    if (lastLen > 0 && lastLen === this.lastLen && tail === this.lastTail) {
      if (elapsed >= this.minElapsed) {
        this.stable += 1;
        if (this.stable >= this.stablePolls) {
          return ['done', `stable ${lastLen} chars x${this.stablePolls}`];
        }
      }
    } else {
      this.stable = 0;
    }

    this.lastLen = lastLen;
    this.lastTail = tail;

    if (this.hardTimeout > 0 && elapsed > this.hardTimeout) {
      return ['hard_timeout', `no stable reply after ${elapsed.toFixed(0)}s`];
    }

    return ['waiting', `len=${lastLen}`];
  }

  disqualify(): void {
    this.stable = 0;
    this.lastLen = -1;
    this.lastTail = null;
  }

  reset(): void {
    this.start = Date.now() / 1000;
    this.stable = 0;
    this.lastLen = -1;
    this.lastTail = null;
  }
}

// ---------------------------------------------------------------- logout ----
export const LOGOUT_JS = String.raw`
(() => {
  const body = (document.body && document.body.innerText) || '';
  const low = body.toLowerCase();
  const loggedOut =
    /require you to be logged in/i.test(low) ||
    (/sign up/i.test(low) && /log in/i.test(low) && /cursor.?s ai features/i.test(low)) ||
    /需要登录/.test(body) ||
    /(已退出登录|重新登录|会话已过期|session expired|you have been signed out)/i.test(body);
  const extra = __EXTRA__;
  let extraHit = false;
  for (const k of extra) if (body.includes(k)) { extraHit = true; break; }
  return { loggedOut: loggedOut || extraHit, tail: body.slice(-600) };
})()
`;

export function buildLogoutJs(cfg: DetectionConfig): string {
  return LOGOUT_JS.replace('__EXTRA__', JSON.stringify(cfg.loggedOutKeywords));
}
