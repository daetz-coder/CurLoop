"""
CursorHarness CDP smoke verification.

Launches (or attaches to) Cursor with --remote-debugging-port and probes:
- page targets
- chat input candidates
- dismiss / modal candidates
- new-chat candidates
Optionally: focus input + insertText (no submit by default).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

import websockets.sync.client as ws_client

CURSOR_EXE = Path(r"C:\Program Files\cursor\Cursor.exe")
DEFAULT_PORT = 9333  # avoid colliding with common 9222 usage
DEFAULT_PROFILE = Path(__file__).resolve().parent / ".harness-profile"


@dataclass
class ProbeResult:
    ok: bool
    port: int
    version: dict[str, Any] | None
    targets: list[dict[str, Any]]
    pages_probed: list[dict[str, Any]]
    errors: list[str]
    launch_pid: int | None = None


def http_json(url: str, timeout: float = 2.0) -> Any:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_cdp(port: int, timeout_s: float = 60.0) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    last_err = ""
    while time.time() < deadline:
        try:
            return http_json(f"http://127.0.0.1:{port}/json/version")
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            time.sleep(0.5)
    raise TimeoutError(f"CDP not reachable on {port}: {last_err}")


def list_targets(port: int) -> list[dict[str, Any]]:
    return http_json(f"http://127.0.0.1:{port}/json/list")


class CdpSession:
    def __init__(self, ws_url: str):
        self._ws = ws_client.connect(ws_url, max_size=16 * 1024 * 1024)
        self._id = 0

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> Any:
        self._id += 1
        msg_id = self._id
        payload = {"id": msg_id, "method": method}
        if params:
            payload["params"] = params
        self._ws.send(json.dumps(payload))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self._ws.recv()
            data = json.loads(raw)
            if data.get("id") == msg_id:
                if "error" in data:
                    raise RuntimeError(f"{method}: {data['error']}")
                return data.get("result")
        raise TimeoutError(f"CDP timeout: {method}")

    def evaluate(self, expression: str) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(result["exceptionDetails"])
        return result.get("result", {}).get("value")

    def close(self) -> None:
        try:
            self._ws.close()
        except Exception:  # noqa: BLE001
            pass


PROBE_JS = r"""
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

  // Broad contenteditable near bottom half
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
    const blob = `${t} ${aria} ${title}`.trim();
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

  // Modal-ish overlays
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

  // Deduplicate inputs by rect
  const uniq = [];
  const seen = new Set();
  for (const item of inputs) {
    const key = `${item.rect.x},${item.rect.y},${item.rect.w},${item.rect.h},${item.kind}`;
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
"""


FOCUS_AND_TYPE_JS_TEMPLATE = r"""
(async (payload) => {
  const { selector, text, submit } = payload;
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: 'selector_not_found', selector };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  el.focus();
  el.click();
  return { ok: true, selector, tag: el.tagName, focused: document.activeElement === el };
})(PAYLOAD)
"""


def launch_cursor(port: int, profile: Path, workspace: Path | None) -> subprocess.Popen:
    profile.mkdir(parents=True, exist_ok=True)
    args = [
        str(CURSOR_EXE),
        f"--remote-debugging-port={port}",
        f"--remote-allow-origins=*",
        f"--user-data-dir={profile}",
        "--disable-workspace-trust",
        "--new-window",
    ]
    if workspace:
        args.append(str(workspace))
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def is_workbench_target(t: dict[str, Any]) -> bool:
    url = (t.get("url") or "").lower()
    title = (t.get("title") or "").lower()
    typ = t.get("type")
    if typ not in ("page", "other"):
        return False
    if "devtools://" in url or "extension" in url and "vscode-file" not in url:
        return False
    # Cursor/VS Code workbench usually vscode-file or empty chrome-error during boot
    if "vscode-file://" in url or "workbench" in url or "cursor" in title or url.startswith("vscode-webview"):
        return True
    if typ == "page" and t.get("webSocketDebuggerUrl"):
        return True
    return False


def probe_pages(port: int, max_pages: int = 6) -> tuple[list[dict[str, Any]], list[str]]:
    targets = list_targets(port)
    pages: list[dict[str, Any]] = []
    errors: list[str] = []
    candidates = [t for t in targets if t.get("webSocketDebuggerUrl") and is_workbench_target(t)]
    if not candidates:
        candidates = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]

    for t in candidates[:max_pages]:
        ws_url = t["webSocketDebuggerUrl"]
        session = None
        try:
            session = CdpSession(ws_url)
            session.call("Runtime.enable")
            # Give renderer a moment if still booting
            probe = None
            for attempt in range(8):
                try:
                    probe = session.evaluate(PROBE_JS)
                    if probe and (probe.get("inputCount", 0) > 0 or attempt >= 3):
                        break
                except Exception as e:  # noqa: BLE001
                    probe = {"error": str(e)}
                time.sleep(1.0)
            pages.append(
                {
                    "targetId": t.get("id"),
                    "title": t.get("title"),
                    "url": t.get("url"),
                    "type": t.get("type"),
                    "probe": probe,
                }
            )
        except Exception as e:  # noqa: BLE001
            errors.append(f"probe {t.get('id')}: {e}")
        finally:
            if session:
                session.close()
    return pages, errors


def try_focus_and_type(port: int, page: dict[str, Any], text: str, submit: bool) -> dict[str, Any]:
    targets = list_targets(port)
    target = next((t for t in targets if t.get("id") == page.get("targetId")), None)
    if not target or not target.get("webSocketDebuggerUrl"):
        return {"ok": False, "reason": "target_missing"}

    probe = page.get("probe") or {}
    inputs = probe.get("inputs") or []
    if not inputs:
        return {"ok": False, "reason": "no_input_candidates"}

    # Prefer known chat selectors
    preferred = None
    for item in inputs:
        sel = item.get("selector") or ""
        if "aislash" in sel or "lexical" in sel or "Ask" in (item.get("ariaLabel") or "") or item.get("kind") == "input_candidate":
            preferred = item
            break
    if not preferred:
        preferred = inputs[0]

    selector = preferred["selector"]
    session = CdpSession(target["webSocketDebuggerUrl"])
    try:
        session.call("Runtime.enable")
        session.call("Input.setIgnoreInputEvents", {"ignore": False})
        focus_js = FOCUS_AND_TYPE_JS_TEMPLATE.replace("PAYLOAD", json.dumps({"selector": selector, "text": text, "submit": submit}))
        focus_result = session.evaluate(focus_js)
        # Clear then type via CDP Input domain (ProseMirror-safe)
        session.call("Input.dispatchKeyEvent", {"type": "keyDown", "modifiers": 2, "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65})
        session.call("Input.dispatchKeyEvent", {"type": "keyUp", "modifiers": 2, "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65})
        session.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8})
        session.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8})
        session.call("Input.insertText", {"text": text})
        typed_check = session.evaluate(
            """(() => {
              const a = document.activeElement;
              return {
                tag: a && a.tagName,
                text: ((a && (a.innerText || a.value)) || '').slice(0, 200),
                contentEditable: a && a.getAttribute('contenteditable'),
              };
            })()"""
        )
        if submit:
            session.call(
                "Input.dispatchKeyEvent",
                {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13},
            )
            session.call(
                "Input.dispatchKeyEvent",
                {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13},
            )
        return {
            "ok": True,
            "selector": selector,
            "focus": focus_result,
            "typed_check": typed_check,
            "submitted": submit,
        }
    finally:
        session.close()


def try_dismiss(port: int, page: dict[str, Any]) -> dict[str, Any]:
    probe = page.get("probe") or {}
    dismiss = [b for b in (probe.get("buttons") or []) if b.get("kind") == "dismiss"]
    if not dismiss:
        return {"ok": False, "reason": "no_dismiss_button"}

    targets = list_targets(port)
    target = next((t for t in targets if t.get("id") == page.get("targetId")), None)
    if not target:
        return {"ok": False, "reason": "target_missing"}

    btn = dismiss[0]
    # Click by matching visible text via JS
    session = CdpSession(target["webSocketDebuggerUrl"])
    try:
        session.call("Runtime.enable")
        result = session.evaluate(
            f"""(() => {{
              const want = {json.dumps(btn.get('text') or btn.get('ariaLabel') or '')}.toLowerCase();
              const nodes = [...document.querySelectorAll('button, [role="button"], a')];
              const el = nodes.find(n => ((n.innerText||n.getAttribute('aria-label')||'')+'').trim().toLowerCase() === want)
                || nodes.find(n => /not now|maybe later|no thanks|skip|稍后再说|暂不|关闭/i.test(((n.innerText||n.getAttribute('aria-label')||'')+'')));
              if (!el) return {{ ok:false, reason:'not_found' }};
              el.click();
              return {{ ok:true, text: ((el.innerText||el.getAttribute('aria-label')||'')+'').trim().slice(0,80) }};
            }})()"""
        )
        return {"ok": bool(result and result.get("ok")), "detail": result, "candidate": btn}
    finally:
        session.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--launch", action="store_true", help="Launch Cursor with CDP + isolated profile")
    parser.add_argument("--attach-only", action="store_true", help="Do not launch; only attach")
    parser.add_argument("--type-text", default="CursorHarness CDP probe — do not submit")
    parser.add_argument("--submit", action="store_true", help="Actually press Enter after typing")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "verify-report.json")
    parser.add_argument("--wait", type=float, default=90.0)
    args = parser.parse_args()

    errors: list[str] = []
    launch_pid = None
    version = None

    # Attach if already up, else launch when requested
    try:
        version = http_json(f"http://127.0.0.1:{args.port}/json/version")
        print(f"[ok] CDP already up on {args.port}: {version.get('Browser')}")
    except Exception:
        if args.attach_only:
            print(f"[fail] CDP not reachable on {args.port}")
            return 2
        if not args.launch and not args.attach_only:
            args.launch = True
        if args.launch:
            if not CURSOR_EXE.exists():
                print(f"[fail] Cursor not found: {CURSOR_EXE}")
                return 2
            print(f"[..] launching Cursor CDP={args.port} profile={args.profile}")
            proc = launch_cursor(args.port, args.profile, args.workspace)
            launch_pid = proc.pid
            print(f"[ok] launched pid={launch_pid}")
            try:
                version = wait_cdp(args.port, timeout_s=args.wait)
                print(f"[ok] CDP ready: {version.get('Browser')}")
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
                print(f"[fail] {e}")
                report = ProbeResult(False, args.port, None, [], [], errors, launch_pid)
                args.out.write_text(json.dumps(asdict(report), ensure_ascii=False, indent=2), encoding="utf-8")
                return 2

    # Wait for workbench page to settle
    print("[..] waiting for page targets...")
    pages: list[dict[str, Any]] = []
    deadline = time.time() + min(args.wait, 75)
    while time.time() < deadline:
        targets = list_targets(args.port)
        page_like = [t for t in targets if t.get("webSocketDebuggerUrl")]
        print(f"    targets={len(targets)} with_ws={len(page_like)}")
        pages, probe_errors = probe_pages(args.port)
        errors.extend(probe_errors)
        if any((p.get("probe") or {}).get("inputCount", 0) > 0 for p in pages):
            break
        if pages and any((p.get("probe") or {}).get("bodyTextSample") for p in pages):
            # UI up but maybe chat not open yet
            if time.time() + 5 > deadline:
                break
        time.sleep(2.0)

    targets = list_targets(args.port)
    actions: dict[str, Any] = {}

    # Pick best page (most input candidates)
    best = None
    for p in pages:
        probe = p.get("probe") or {}
        score = int(probe.get("inputCount") or 0) * 10 + len(probe.get("buttons") or [])
        if best is None or score > best[0]:
            best = (score, p)

    if best:
        page = best[1]
        print(f"[ok] best page title={page.get('title')!r} inputs={(page.get('probe') or {}).get('inputCount')}")
        actions["dismiss"] = try_dismiss(args.port, page)
        print(f"[..] dismiss: {actions['dismiss']}")
        # Re-probe after dismiss attempt
        time.sleep(1.0)
        pages2, err2 = probe_pages(args.port)
        errors.extend(err2)
        # refresh best
        for p in pages2:
            if p.get("targetId") == page.get("targetId"):
                page = p
                break
        actions["type"] = try_focus_and_type(args.port, page, args.type_text, args.submit)
        print(f"[..] type: {actions['type']}")
        pages = pages2 or pages

    summary = {
        "ok": bool(best and ((best[1].get("probe") or {}).get("inputCount", 0) > 0 or actions.get("type", {}).get("ok"))),
        "port": args.port,
        "version": version,
        "target_count": len(targets),
        "targets": [
            {"id": t.get("id"), "type": t.get("type"), "title": t.get("title"), "url": (t.get("url") or "")[:160]}
            for t in targets
        ],
        "pages": pages,
        "actions": actions,
        "errors": errors,
        "launch_pid": launch_pid,
        "criteria": {
            "cdp_reachable": version is not None,
            "found_input": any((p.get("probe") or {}).get("inputCount", 0) > 0 for p in pages),
            "found_dismiss": any(
                b.get("kind") == "dismiss" for p in pages for b in ((p.get("probe") or {}).get("buttons") or [])
            ),
            "found_new_chat": any(
                b.get("kind") == "new_chat" for p in pages for b in ((p.get("probe") or {}).get("buttons") or [])
            ),
            "typed_ok": bool(actions.get("type", {}).get("ok")),
        },
    }
    # overall ok if CDP works and we found inputs OR typed
    summary["ok"] = bool(summary["criteria"]["cdp_reachable"] and (summary["criteria"]["found_input"] or summary["criteria"]["typed_ok"]))

    args.out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ok] report => {args.out}")
    print(json.dumps(summary["criteria"], ensure_ascii=False, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
