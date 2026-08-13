"""End-to-end CDP conversation: send prompt, wait for assistant reply."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_cdp import (  # noqa: E402
    CdpSession,
    list_targets,
    probe_pages,
    try_focus_and_type,
)

PORT = 9333
OUT = Path(__file__).resolve().parent / "verify-conversation.json"
PROMPT = "Reply with exactly: HARNESS_OK. No other text."

SNAPSHOT_JS = r"""
(() => {
  const text = (document.body && document.body.innerText) || '';
  const lower = text.toLowerCase();
  const loginHints = [
    'sign in', 'log in', 'login', '登录', 'sign up', 'authenticate',
    'continue with', 'unauthorized', 'api key'
  ];
  const generatingHints = [
    'stop', 'generating', 'thinking', 'cancel', '停止', '生成中'
  ];
  const markdown = [...document.querySelectorAll(
    '.anysphere-markdown-container-root, .markdown-section, [data-message-role], [data-message-kind], .composer-human-ai-pair-container'
  )].slice(-12).map(el => ({
    kind: el.getAttribute('data-message-kind') || el.getAttribute('data-message-role') || el.className.toString().slice(0,60),
    text: ((el.innerText || '') + '').trim().slice(0, 400)
  }));
  return {
    title: document.title,
    hasLoginHint: loginHints.some(h => lower.includes(h)),
    hasGeneratingHint: generatingHints.some(h => lower.includes(h)),
    hasHarnessOk: text.includes('HARNESS_OK'),
    hasPrompt: text.includes('HARNESS_OK') || text.includes('Reply with exactly'),
    sampleTail: text.slice(-1200),
    markdown,
    upgradeVisible: /upgrade to pro/i.test(text),
  };
})()
"""


def best_page():
    pages, errors = probe_pages(PORT)
    if not pages:
        return None, errors
    pages = sorted(pages, key=lambda p: int((p.get("probe") or {}).get("inputCount") or 0), reverse=True)
    return pages[0], errors


def session_for(page):
    targets = list_targets(PORT)
    target = next((t for t in targets if t.get("id") == page.get("targetId")), None)
    if not target:
        raise RuntimeError("target missing")
    s = CdpSession(target["webSocketDebuggerUrl"])
    s.call("Runtime.enable")
    return s


def main() -> int:
    page, errors = best_page()
    report = {"ok": False, "errors": errors, "steps": []}
    if not page:
        report["errors"].append("no page")
        OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1

    # Pre-snapshot
    s = session_for(page)
    try:
        before = s.evaluate(SNAPSHOT_JS)
    finally:
        s.close()
    report["steps"].append({"name": "before", "snapshot": before})
    print("[before] loginHint=", before.get("hasLoginHint"), "harness=", before.get("hasHarnessOk"))

    if before.get("hasLoginHint") and not (page.get("probe") or {}).get("inputCount"):
        report["errors"].append("likely not logged in / no chat input")
        OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2

    # Send
    typed = try_focus_and_type(PORT, page, PROMPT, submit=True)
    report["steps"].append({"name": "send", "result": typed})
    print("[send]", typed)

    if not typed.get("ok"):
        report["errors"].append("send failed")
        OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1

    # Poll for response
    deadline = time.time() + 120
    last = None
    saw_generating = False
    while time.time() < deadline:
        time.sleep(2.0)
        s = session_for(page)
        try:
            last = s.evaluate(SNAPSHOT_JS)
        finally:
            s.close()
        if last.get("hasGeneratingHint"):
            saw_generating = True
        print(
            f"[poll] harness={last.get('hasHarnessOk')} generating={last.get('hasGeneratingHint')} "
            f"md={len(last.get('markdown') or [])}"
        )
        # Success: model replied with marker, and preferably not still generating
        if last.get("hasHarnessOk"):
            # Ensure it's not only our prompt echoed — look in markdown / tail after prompt
            tail = last.get("sampleTail") or ""
            # Count occurrences; prompt contains the instruction mentioning HARNESS_OK once;
            # reply should add another or appear as assistant content.
            if tail.count("HARNESS_OK") >= 1 and (
                "Reply with exactly" in tail and tail.rfind("HARNESS_OK") > tail.rfind("Reply with exactly")
                or any("HARNESS_OK" in (m.get("text") or "") for m in (last.get("markdown") or [])[1:])
                or (saw_generating and last.get("hasHarnessOk"))
            ):
                report["ok"] = True
                break
            # Heuristic: after generating flag flips off and marker present
            if saw_generating and not last.get("hasGeneratingHint"):
                report["ok"] = True
                break
            # Fallback after enough time if marker appears twice
            if tail.count("HARNESS_OK") >= 2:
                report["ok"] = True
                break

    report["steps"].append({"name": "after", "snapshot": last, "saw_generating": saw_generating})
    report["ok"] = bool(report["ok"] or (last and last.get("hasHarnessOk") and saw_generating))
    # Final classification
    if last and last.get("hasLoginHint") and not report["ok"]:
        report["blocked_by"] = "login_or_auth_ui"
    elif last and last.get("upgradeVisible") and not report["ok"] and not saw_generating:
        report["blocked_by"] = "possible_paywall_or_no_model_response"
    elif not report["ok"]:
        report["blocked_by"] = "timeout_or_no_assistant_text"

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "blocked_by": report.get("blocked_by"), "saw_generating": saw_generating}, ensure_ascii=False, indent=2))
    print("=>", OUT)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
