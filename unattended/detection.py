"""CDP DOM detection for the unattended loop.

Three JS snippets (injected into the Cursor workbench via Runtime.evaluate) and
the Python-side classifiers:
  * build_limit_js  /  classify_limit   — usage-limit banner/dialog
  * REPLY_JS        /  CompletionTracker — generic "reply finished" without a marker
  * build_logout_js /  (bool in REPLY_JS too) — logged-out mid-run
"""

from __future__ import annotations

import json
import time
from collections import deque
from typing import Any

from .config import DetectionConfig

# ---------------------------------------------------------------- limit ----
_LIMIT_JS = r"""
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
"""


def build_limit_js(cfg: DetectionConfig) -> str:
    return _LIMIT_JS % {
        "en": json.dumps(cfg.limit_keywords_en, ensure_ascii=False),
        "cn": json.dumps(cfg.limit_keywords_cn, ensure_ascii=False),
    }


def classify_limit(sample: dict[str, Any], prev_hits: set[str], require_recent: bool) -> tuple[bool, str | None]:
    """Return (is_limit, reason). `prev_hits` lets us require the signal to be fresh."""
    hits = set(sample.get("hits") or [])
    if sample.get("hard"):
        return True, "hard: " + ",".join(sorted(hits)[:6])
    if len(hits) >= 2:
        if require_recent and prev_hits and hits <= prev_hits:
            return False, None  # stale / always-present upsell, not a fresh limit
        return True, "multi: " + ",".join(sorted(hits)[:6])
    return False, None


# ------------------------------------------------------------ completion ----
REPLY_JS = r"""
(() => {
  const body = (document.body && document.body.innerText) || '';
  const hasStop = !!document.querySelector(
    'button[aria-label*="stop" i], button[aria-label*="停止" i], button[aria-label*="cancel" i], button[aria-label*="取消" i], button[title*="stop" i], button[title*="停止" i], [class*="stop-generating" i], [class*="stop" i][role="button"]'
  );
  const read = (el) => ((el.innerText || el.textContent || '') + '').trim();
  // Prefer assistant-role nodes; fall back to any message container.
  const assistant = [...document.querySelectorAll(
    '[data-message-role="assistant"], [data-message-kind*="assistant" i], [data-message-role*="assistant" i], .anysphere-markdown-container-root'
  )].map(read).filter(Boolean);
  const pairs = [...document.querySelectorAll(
    '.composer-human-ai-pair-container, [data-message-kind], [data-message-role]'
  )].map(read).filter(Boolean);
  const all = assistant.length ? assistant : pairs;
  const last = all[all.length - 1] || '';
  // Composer state: non-empty means an unsent/queued input — the previous
  // reply is NOT finished yet (prevents queueing the next prompt too early).
  const composer = document.querySelector('.aislash-editor-input');
  const composerText = (composer && ((composer.innerText || composer.textContent || '') + '').trim()) || '';
  // Busy hints must be progressive ("is thinking", "正在写入", "运行中"), not
  // past-tense ("已写入", "已完成") — a completion reply like "已写入
  // selftest_output.txt" previously matched the bare verb 写入 and kept the
  // tracker busy forever.
  // Scope: only the LAST few messages, never document.body. Whole-body scans
  // pick up static UI text (git timeline commit messages like "related
  // planning files", sidebar labels) and pin busy=True forever.
  const thinking = /(thinking|generating|working on|planning|正在思考|思考中|生成中|运行中|正在运行|正在执行|正在生成|正在读取|正在编辑|正在写入|正在搜索|正在规划|正在准备)/i.test(
    all.slice(-3).join('\n') || ''
  );
  const toolActivity = /(running|executing|searching|reading|editing|writing|planning|applying|running terminal|正在运行|正在执行|正在搜索|正在读取|正在编辑|正在写入|正在规划|正在应用|运行中|执行中|处理中|规划中|读取中|准备中)/i.test(last);
  // Long tool runs (minutes) may keep the LAST message stable; look at the
  // last few messages so an in-progress tool card ("正在执行 xxx") still
  // counts as busy instead of declaring done early. Covers shell / explore /
  // edit / read / planning / search / write / apply tool activity.
  const toolRunning = /(running|executing|processing|working|reading|planning|searching|writing|applying|exploring|inspecting|waiting for|正在运行|正在执行|正在读取|正在规划|正在搜索|正在写入|正在应用|正在检查|正在等待|执行中|运行中|读取中|规划中|搜索中|处理中|进行中|准备中|等待中)/i.test(
    (all.slice(-3).join('\n') || '')
  );
  // Tool-card count: a changing count means the agent is still working
  // (executing/opening/editing files), even if the last text is stable.
  const toolCardCount = document.querySelectorAll('.ui-tool-call-card, [class*="tool-call-card" i]').length;
  // Tool-card HEADERS are the reliable in-progress signal ("Waiting for shell",
  // "Run xxx") — they live outside the assistant-message selectors, so check
  // them directly (last few cards).
  const cardHeaders = [...document.querySelectorAll('.ui-tool-call-card__header, .ui-shell-tool-call__card')]
    .map((e) => (e.innerText || '').trim())
    .filter(Boolean);
  const lastCard = cardHeaders[cardHeaders.length - 1] || '';
  // "Waiting xxx for shell" has words between Waiting and for, so match the
  // bare word too; also treat a last card whose title STARTS with Wait/Run/Exec
  // as still in progress (the agent is mid-tool).
  // IMPORTANT: bare running/executing/pending match tool-card TITLES ("Check
  // ... and running processes") of historical/finished calls and pin busy=True
  // forever — keep explicit in-progress state words only.
  const toolWaiting = /(waiting|awaiting|in progress|请稍候|等待中|执行中|运行中|处理中|进行中|准备中|正在)/i.test(
    cardHeaders.slice(-3).join(' ')
  )
    || /^(wait|run|exec|正在|等待|执行)/i.test(lastCard);
  // THE definitive signal: Cursor shows "N Queued" — N>0 means previous
  // prompts are still pending, so we must NOT send anything else.
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
"""


class CompletionTracker:
    """Declares a reply 'done' when, for N consecutive polls, the assistant
    content is non-empty, identical, and not busy. Never hard-times-out while
    busy (Agent tool execution can run for a long time)."""

    def __init__(self, stable_polls: int = 4, min_elapsed: float = 10.0, hard_timeout: float = 900.0, poll_interval: float = 3.0):
        self.stable_polls = max(2, stable_polls)
        self.min_elapsed = min_elapsed
        self.hard_timeout = hard_timeout
        self.poll_interval = poll_interval
        self._stable = 0
        self._last_len = -1
        self._last_tail: str | None = None
        self._last_pairs = -1
        self._last_tool_cards = -1
        self.start = time.time()
        self._history: deque[tuple[float, int]] = deque(maxlen=20)

    def update(self, s: dict[str, Any]) -> tuple[str, str]:
        """Return (state, detail). state in {busy, done, waiting, hard_timeout, logged_out}."""
        elapsed = time.time() - self.start
        self._history.append((elapsed, int(s.get("lastLen", 0) or 0)))

        if s.get("loggedOut"):
            self._stable = 0
            return "logged_out", "logged out mid-run"

        if s.get("busy"):
            self._stable = 0
            self._last_len = -1
            self._last_tail = None
            flags = "+".join(
                k for k in ("hasStop", "thinking", "toolActivity", "toolRunning",
                            "toolWaiting", "hasQueued", "composerText")
                if s.get(k)
            )
            return "busy", f"agent busy {elapsed:.0f}s ({flags or '?'})"

        last_len = int(s.get("lastLen", 0) or 0)
        tail = s.get("lastTail") or ""

        # A new message pair appearing (pairCount increased) means the agent
        # started another reply — restart the stability count even if the last
        # text happened to look unchanged.
        pairs = int(s.get("pairCount", 0) or 0)
        if self._last_pairs >= 0 and pairs != self._last_pairs:
            self._stable = 0
        self._last_pairs = pairs

        # A changing tool-card count means the agent is still executing tools
        # (shell/explore/edit), even if the last text is stable.
        cards = int(s.get("toolCardCount", 0) or 0)
        if self._last_tool_cards >= 0 and cards != self._last_tool_cards:
            self._stable = 0
        self._last_tool_cards = cards

        if last_len > 0 and last_len == self._last_len and tail == self._last_tail:
            if elapsed >= self.min_elapsed:
                self._stable += 1
                if self._stable >= self.stable_polls:
                    return "done", f"stable {last_len} chars x{self.stable_polls}"
        else:
            self._stable = 0

        self._last_len = last_len
        self._last_tail = tail

        if self.hard_timeout > 0 and elapsed > self.hard_timeout:
            return "hard_timeout", f"no stable reply after {elapsed:.0f}s"

        return "waiting", f"len={last_len}"

    def disqualify(self) -> None:
        """Drop the stable-count so the tracker re-counts from scratch
        (used when the 'last message' turned out to be the prompt echo)."""
        self._stable = 0
        self._last_len = -1
        self._last_tail = None

    def reset(self) -> None:
        self.start = time.time()
        self._stable = 0
        self._last_len = -1
        self._last_tail = None


# ---------------------------------------------------------------- logout ----
_LOGOUT_JS = r"""
(() => {
  const body = (document.body && document.body.innerText) || '';
  const low = body.toLowerCase();
  const loggedOut =
    /require you to be logged in/i.test(low) ||
    (/sign up/i.test(low) && /log in/i.test(low) && /cursor.?s ai features/i.test(low)) ||
    /需要登录/.test(body) ||
    /(已退出登录|重新登录|会话已过期|session expired|you have been signed out)/i.test(body);
  const extra = %(extra)s;
  let extraHit = false;
  for (const k of extra) if (body.includes(k)) { extraHit = true; break; }
  return { loggedOut: loggedOut || extraHit, tail: body.slice(-600) };
})()
"""


def build_logout_js(cfg: DetectionConfig) -> str:
    return _LOGOUT_JS % {"extra": json.dumps(cfg.logged_out_keywords, ensure_ascii=False)}
