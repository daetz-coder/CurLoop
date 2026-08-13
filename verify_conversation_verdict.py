"""Re-classify conversation result without false positives from prompt echo."""

from __future__ import annotations

import json
from pathlib import Path

p = Path(__file__).resolve().parent / "verify-conversation.json"
report = json.loads(p.read_text(encoding="utf-8"))
after = next(s["snapshot"] for s in report["steps"] if s["name"] == "after")
send = next(s["result"] for s in report["steps"] if s["name"] == "send")

tail = after.get("sampleTail") or ""
auth_blocked = "require you to be logged in" in tail or "需要登录" in tail
assistant_markdown = after.get("markdown") or []
# Prompt is still sitting in composer; that is NOT a reply.
prompt_only = "Reply with exactly: HARNESS_OK" in tail and not assistant_markdown
generating = bool(report["steps"][-1].get("saw_generating"))

verdict = {
    "ui_send_ok": bool(send.get("ok") and send.get("submitted")),
    "auth_blocked": auth_blocked,
    "assistant_reply_seen": bool(assistant_markdown) and not auth_blocked,
    "generating_seen": generating,
    "can_converse_now": False,
    "reason": "",
}
if not verdict["ui_send_ok"]:
    verdict["reason"] = "CDP failed to type/submit into chat input"
elif auth_blocked:
    verdict["reason"] = "Harness profile is logged out; Cursor blocks AI until Sign In"
elif verdict["assistant_reply_seen"]:
    verdict["can_converse_now"] = True
    verdict["reason"] = "Assistant markdown reply observed"
else:
    verdict["reason"] = "Submitted to UI but no assistant reply observed"

out = Path(__file__).resolve().parent / "verify-conversation-verdict.json"
out.write_text(json.dumps(verdict, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(verdict, ensure_ascii=False, indent=2))
