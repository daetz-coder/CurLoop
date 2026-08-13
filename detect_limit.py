"""
Monitor a CDP-enabled Cursor window for usage/rate-limit UI signals.

No account switching. Read-only observe + classify screen state.
Requires Cursor launched with --remote-debugging-port.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_cdp import CdpSession, list_targets, probe_pages  # noqa: E402

# Phrases reported in Cursor UI / forums (EN + common CN)
LIMIT_PATTERNS = [
    r"you've hit your usage limit",
    r"you.?ve hit your (usage )?limit",
    r"hit your limit of \d+",
    r"usage limit",
    r"rate limit exceeded",
    r"too many requests",
    r"slow request",
    r"switch to (a )?slow",
    r"pay for (additional|extra) usage",
    r"upgrade your (plan|subscription)",
    r"out of (fast )?requests",
    r"monthly limit",
    r"quota exceeded",
    r"已达到?(用量|使用)?上限",
    r"用量上限",
    r"请求过多",
    r"速率限制",
    r"超出.*限制",
    r"升级.*套餐",
]

AUTH_PATTERNS = [
    r"require you to be logged in",
    r"sign in to use",
    r"cursor.?s ai features require",
    r"需要登录",
]

GENERATING_PATTERNS = [
    r"stop generating",
    r"stop$",
    r"generating",
    r"thinking",
    r"停止生成",
]

CLASSIFY_JS = r"""
(() => {
  const textOf = (el) => ((el.innerText || el.textContent || el.getAttribute?.('aria-label') || '') + '').trim();
  const full = ((document.body && document.body.innerText) || '');
  const lower = full.toLowerCase();

  // Prefer chat/agent region text if present
  const regions = [];
  document.querySelectorAll(
    '[class*="composer"], [class*="agent"], [class*="chat"], [role="dialog"], [aria-modal="true"], .notification-toast-container'
  ).forEach((el) => {
    const t = textOf(el);
    if (t && t.length < 4000) regions.push(t.slice(0, 800));
  });

  const buttons = [];
  document.querySelectorAll('button, [role="button"], a').forEach((el) => {
    const t = textOf(el);
    if (!t) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (/upgrade|usage|limit|slow|retry|resume|继续|升级|重试/i.test(t)) {
      buttons.push({ text: t.slice(0, 80), x: Math.round(r.x), y: Math.round(r.y) });
    }
  });

  return {
    title: document.title,
    fullSampleTail: full.slice(-1500),
    regionSamples: regions.slice(-8),
    actionButtons: buttons.slice(0, 20),
    lowerLen: lower.length,
  };
})()
"""


def compile_res(patterns: list[str]):
    import re

    return [re.compile(p, re.I) for p in patterns]


LIMIT_RE = compile_res(LIMIT_PATTERNS)
AUTH_RE = compile_res(AUTH_PATTERNS)
GEN_RE = compile_res(GENERATING_PATTERNS)


def match_any(text: str, regs) -> list[str]:
    hits = []
    for r in regs:
        m = r.search(text or "")
        if m:
            hits.append(m.group(0))
    return hits


def classify(snapshot: dict[str, Any]) -> dict[str, Any]:
    blobs = [
        snapshot.get("fullSampleTail") or "",
        "\n".join(snapshot.get("regionSamples") or []),
        "\n".join(b.get("text") or "" for b in (snapshot.get("actionButtons") or [])),
    ]
    text = "\n".join(blobs)
    limit_hits = match_any(text, LIMIT_RE)
    auth_hits = match_any(text, AUTH_RE)
    gen_hits = match_any(text, GEN_RE)

    # Soft signals: upgrade CTA alone is weak (often always visible "Upgrade to Pro")
    strong_limit = any(
        h
        for h in limit_hits
        if "upgrade" not in h.lower() and "升级" not in h
    )
    # If only "upgrade your plan" near "usage limit" / "pay for" → still limit
    if not strong_limit and limit_hits:
        joined = " ".join(limit_hits).lower()
        strong_limit = "usage limit" in joined or "rate limit" in joined or "上限" in joined

    state = "ok"
    if auth_hits and "require" in " ".join(auth_hits).lower():
        state = "logged_out"
    elif strong_limit:
        state = "usage_or_rate_limit"
    elif gen_hits:
        state = "generating"
    elif limit_hits and not strong_limit:
        state = "maybe_limit_weak"  # e.g. persistent Upgrade button

    return {
        "state": state,
        "limit_hits": limit_hits,
        "auth_hits": auth_hits,
        "generating_hits": gen_hits,
        "action_buttons": snapshot.get("actionButtons") or [],
    }


def best_page(port: int):
    pages, errors = probe_pages(port)
    if not pages:
        return None, errors
    pages = sorted(
        pages,
        key=lambda p: int((p.get("probe") or {}).get("inputCount") or 0),
        reverse=True,
    )
    return pages[0], errors


def snapshot_page(port: int, page: dict) -> dict[str, Any]:
    targets = list_targets(port)
    target = next((t for t in targets if t.get("id") == page.get("targetId")), None)
    if not target:
        raise RuntimeError("target missing — is CDP still up?")
    s = CdpSession(target["webSocketDebuggerUrl"])
    try:
        s.call("Runtime.enable")
        return s.evaluate(CLASSIFY_JS) or {}
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Detect Cursor limit UI via CDP")
    ap.add_argument("--port", type=int, default=9333)
    ap.add_argument("--interval", type=float, default=3.0)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "limit-status.json")
    args = ap.parse_args()

    print(
        "Monitor only. Connect to Cursor with CDP, e.g.\n"
        f'  Cursor.exe --remote-debugging-port={args.port} --user-data-dir="%APPDATA%\\Cursor"\n'
    )

    while True:
        page, errors = best_page(args.port)
        record: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "port": args.port,
            "errors": errors,
        }
        if not page:
            record["state"] = "no_page"
            print("[warn] no workbench page — CDP down or Cursor not ready")
        else:
            snap = snapshot_page(args.port, page)
            verdict = classify(snap)
            record.update(verdict)
            record["title"] = snap.get("title")
            record["sample_tail"] = (snap.get("fullSampleTail") or "")[-400:]
            print(
                f"[{record['ts']}] state={record['state']} "
                f"limit={record.get('limit_hits')} auth={record.get('auth_hits')}"
            )

        args.out.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        if args.once:
            return 0 if record.get("state") not in ("no_page",) else 1
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
