"""Second-pass actions: click New Chat, re-probe inputs."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_cdp import CdpSession, list_targets, probe_pages, try_focus_and_type  # noqa: E402

PORT = 9333
OUT = Path(__file__).resolve().parent / "verify-actions.json"


def click_new_chat(port: int, page: dict) -> dict:
    targets = list_targets(port)
    target = next((t for t in targets if t.get("id") == page.get("targetId")), None)
    if not target:
        return {"ok": False, "reason": "target_missing"}
    session = CdpSession(target["webSocketDebuggerUrl"])
    try:
        session.call("Runtime.enable")
        result = session.evaluate(
            r"""(() => {
              const nodes = [...document.querySelectorAll('button, [role="button"], a, div')];
              const el = nodes.find(n => {
                const t = ((n.getAttribute('aria-label') || n.getAttribute('title') || n.innerText || '') + '').trim();
                return /^(new chat|new agent|新对话|新建聊天)$/i.test(t) || /new chat/i.test(t);
              });
              if (!el) return { ok:false, reason:'not_found', sample: nodes.filter(n => /new/i.test((n.getAttribute('aria-label')||'')+'')).slice(0,5).map(n => n.getAttribute('aria-label')) };
              el.click();
              return { ok:true, text: ((el.getAttribute('aria-label')||el.innerText||'')+'').trim().slice(0,80) };
            })()"""
        )
        return {"ok": bool(result and result.get("ok")), "detail": result}
    finally:
        session.close()


def main() -> int:
    pages, errors = probe_pages(PORT)
    best = max(pages, key=lambda p: int((p.get("probe") or {}).get("inputCount") or 0), default=None)
    if not best:
        print("no pages")
        return 1

    buttons = (best.get("probe") or {}).get("buttons") or []
    print("buttons:", json.dumps(buttons, ensure_ascii=False, indent=2))
    new_chat = click_new_chat(PORT, best)
    print("new_chat:", new_chat)

    import time

    time.sleep(1.5)
    pages2, err2 = probe_pages(PORT)
    errors.extend(err2)
    best2 = next((p for p in pages2 if p.get("targetId") == best.get("targetId")), pages2[0] if pages2 else best)
    typed = try_focus_and_type(PORT, best2, "after new chat — harness ok", submit=False)
    print("typed:", typed)

    report = {
        "buttons_before": buttons,
        "new_chat": new_chat,
        "typed_after": typed,
        "inputs_after": (best2.get("probe") or {}).get("inputs"),
        "errors": errors,
        "ok": bool(new_chat.get("ok") and typed.get("ok")),
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("ok=", report["ok"], "=>", OUT)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
