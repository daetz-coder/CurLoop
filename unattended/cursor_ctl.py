"""Control Cursor via CDP on the REAL profile (%APPDATA%\\Cursor).

Wraps verify_cdp.py + resume_after_auth.py (parent dir). All launch/kill/poll
helpers here; the state machine in loop.py only calls these.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .config import Config
from .detection import (
    REPLY_JS,
    CompletionTracker,
    build_limit_js,
    build_logout_js,
    classify_limit,
)

# Reuse the existing harness as a library (same pattern as resume_after_auth.py).
_PARENT = Path(__file__).resolve().parent.parent
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

import verify_cdp  # noqa: E402
from resume_after_auth import (  # noqa: E402
    best_page,
    read_auth_from_db,
    session_for,
    state_db_path,
    wait_dom_logged_in,
)
from verify_cdp import (  # noqa: E402
    CdpSession,
    http_json,
    launch_cursor,
    try_focus_and_type,
    wait_cdp,
)

_inited = False


def init(cfg: Config) -> None:
    global _inited
    verify_cdp.CURSOR_EXE = cfg.cursor.exe
    # The default 2s CDP HTTP timeout is too tight while a busy workbench loads;
    # raise it for every call made through verify_cdp (list_targets, wait_cdp...).
    _orig_http_json = verify_cdp.http_json

    def _http_json(url: str, timeout: float = 6.0) -> Any:
        return _orig_http_json(url, timeout=timeout)

    verify_cdp.http_json = _http_json
    _inited = True


# --------------------------------------------------------------- lifecycle ----
def cdp_up(port: int) -> bool:
    try:
        version = http_json(f"http://127.0.0.1:{port}/json/version", timeout=1.5)
        return bool(version)
    except Exception:
        return False


def cdp_version(port: int) -> str | None:
    try:
        version = http_json(f"http://127.0.0.1:{port}/json/version", timeout=1.5)
        return str(version.get("Browser", "")) or None
    except Exception:
        return None


def kill_all_cursor(wait_s: float = 2.0) -> None:
    """Kill every Cursor.exe. Never touches CursorLoginAssistant-836.exe."""
    ps = r"""
Get-CimInstance Win32_Process -Filter "Name = 'Cursor.exe'" | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
"""
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True,
        text=True,
        check=False,
    )
    time.sleep(wait_s)


def launch(port: int, profile: Path, workspace: Path | None) -> subprocess.Popen:
    return launch_cursor(port, profile, workspace)


def ensure_ready(cfg: Config, workspace: Path, relaunch: bool = True) -> dict[str, Any]:
    """Bring Cursor up with CDP on the real profile and wait for the chat input.

    Returns {"ok": bool, "launched": bool, "dom": {...}, "page": page|None, "errors": [...]}.
    """
    result: dict[str, Any] = {"ok": False, "launched": False, "errors": []}
    port = cfg.cursor.port

    if not cdp_up(port):
        if not relaunch:
            result["errors"].append("CDP not reachable")
            return result
        result["launched"] = True
        kill_all_cursor()
        try:
            proc = launch(port, cfg.cursor.profile, workspace)
            result["launch_pid"] = proc.pid
            version = wait_cdp(port, timeout_s=cfg.timeouts.cdp_ready_s)
            result["cdp_version"] = version.get("Browser")
            print(f"[cdp] ready: {result['cdp_version']}")
        except Exception as e:  # noqa: BLE001
            result["errors"].append(f"launch: {e}")
            return result
    else:
        result["cdp_version"] = cdp_version(port)

    dom = _wait_dom_resilient(cfg)
    result["dom"] = {k: v for k, v in dom.items() if k != "page"}
    if dom.get("loggedOut") or not dom.get("inputVisible"):
        result["errors"].append("not logged in or chat input not visible")
        return result
    # Modals like "Update recommended" render a few seconds after the workbench
    # loads; poll-dismiss so a late modal can't block the first send.
    result["dismiss"] = dismiss_until_clear(cfg.cursor.port, timeout_s=30.0, poll=2.0)
    result["ok"] = True
    result["page"] = dom.get("page")
    return result


def _wait_dom_resilient(cfg: Config) -> dict[str, Any]:
    """wait_dom_logged_in, but retry on transient CDP/HTTP exceptions."""
    port = cfg.cursor.port
    deadline = time.time() + cfg.timeouts.dom_ready_s
    last: dict[str, Any] = {}
    while time.time() < deadline:
        try:
            last = wait_dom_logged_in(port, timeout_s=max(5.0, deadline - time.time()))
            if last.get("inputVisible") and not last.get("loggedOut"):
                return last
            break  # no exception but no success -> internal timeout already elapsed
        except Exception as e:  # noqa: BLE001
            print(f"[dom] transient error, retrying: {type(e).__name__}: {e}")
            last = {"_error": str(e)}
            time.sleep(2)
    return last


# ------------------------------------------------------------------- auth ----
def auth_info(cfg: Config) -> dict[str, Any]:
    return read_auth_from_db(state_db_path(cfg.cursor.profile))


def auth_fp(cfg: Config) -> str | None:
    info = auth_info(cfg)
    if info.get("has_access_token"):
        return info.get("access_fp")
    return None


def wait_token_change(
    cfg: Config, old_fp: str | None, timeout_s: float, poll: float = 2.0
) -> tuple[bool, dict[str, Any]]:
    """Poll the real profile DB until the access-token fingerprint differs from
    `old_fp` (or a token appears where there was none)."""
    deadline = time.time() + timeout_s
    last: dict[str, Any] = {}
    while time.time() < deadline:
        last = auth_info(cfg)
        fp = last.get("access_fp")
        changed = bool(fp) and fp != old_fp
        print(
            f"[auth] fp={fp} changed={changed} email={last.get('email')} "
            f"token={'yes' if last.get('has_access_token') else 'no'}"
        )
        if changed:
            return True, last
        time.sleep(poll)
    return False, last


# -------------------------------------------------------------- dismiss ----
DISMISS_JS = r"""
(() => {
  const textOf = (el) => ((el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '') + '').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // Safe dismiss phrases (exact). Never matches update/upgrade/restart/buy buttons.
  const safeRe = /^(not now|later|maybe later|no thanks|skip|skip this version|dismiss|close|ok|okay|got it|gotcha|i understand|cancel|取消|稍后|以后再说|稍后再说|暂不|不用了|跳过|关闭|跳过此版本|了解|知道了|好的|确定)$/i;
  // Loose phrases allowed ONLY inside a visible modal (loose "关闭" hit the tab-close button before).
  const safeLoose = /(not now|maybe later|skip this version|remind me later|got it|i understand|dismiss|skip for now|稍后|以后再说|暂不|跳过|关闭|了解|知道了|好的|确定)/i;
  const dangerous = /update|upgrade|restart|buy|purchase|subscribe|upgrade to pro|订阅|升级|立即更新|更新并重启/i;
  // Cursor's real dialogs use these classes (update / promo modals), plus standard markers.
  const modals = [...document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], .modal, .cursor-modal-container, .cursor-modal-backing, .cursor-modal-interior'
  )].filter(visible);
  let clicked = null;
  for (const modal of modals) {
    // 1) real buttons / links
    for (const el of [...modal.querySelectorAll('button, [role="button"], a')].filter(visible)) {
      const t = textOf(el);
      if (!t || dangerous.test(t)) continue;
      if (safeRe.test(t) || safeLoose.test(t)) { el.click(); clicked = t.slice(0, 60); break; }
    }
    if (clicked) break;
    // 2) Cursor renders modal actions as Tailwind divs/spans, not <button>.
    //    Click a leaf whose exact text is a safe phrase (click bubbles to the handler).
    for (const el of modal.querySelectorAll('div, span, a')) {
      if (el.children.length > 0) continue; // leaf-ish
      if (!visible(el)) continue;
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 60 || dangerous.test(t)) continue;
      if (safeRe.test(t)) { el.click(); clicked = t.slice(0, 60); break; }
    }
    if (clicked) break;
    // 3) X-close icon
    const x = [...modal.querySelectorAll(
      '[aria-label="Close" i], [aria-label="Dismiss" i], [title="Close"], button[class*="close" i], .codicon-close, .cursor-modal-dismiss, .codicon-x'
    )].filter(visible)[0];
    if (x) { x.click(); clicked = 'x-close'; break; }
  }
  // No fallback: if no real modal is visible, click nothing (document-wide scanning
  // hit unrelated "关闭" elements before).
  return { ok: !!clicked, clicked, modalCount: modals.length };
})()
"""


def dismiss_all(port: int) -> dict[str, Any]:
    """Dismiss safe onboarding/update/promo modals (Update/Upgrade buttons excluded)."""
    page, errors = best_page(port)
    if not page:
        return {"ok": False, "reason": "no workbench page", "errors": errors}
    s = session_for(port, page)
    try:
        return s.evaluate(DISMISS_JS) or {"ok": False, "reason": "no result"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)}
    finally:
        s.close()


def dismiss_until_clear(port: int, timeout_s: float = 30.0, poll: float = 2.0) -> dict[str, Any]:
    """Poll-dismiss modals until none are visible or timeout.

    Cursor renders some modals (e.g. "Update recommended") only a few seconds
    after the workbench loads, so a single dismiss_all called too early misses
    them. Returns the last result plus a poll/attempt count.
    """
    deadline = time.time() + timeout_s
    attempts = 0
    last: dict[str, Any] = {"ok": False, "reason": "no attempt"}
    while time.time() < deadline:
        attempts += 1
        try:
            last = dismiss_all(port)
        except Exception as e:  # noqa: BLE001
            last = {"ok": False, "reason": str(e)}
        if last.get("modalCount", 1) == 0:
            break
        time.sleep(poll)
    last["attempts"] = attempts
    last["timed_out"] = last.get("modalCount", 1) != 0
    return last


# ------------------------------------------------------------------- send ----
def send_prompt(cfg: Config, prompt: str, submit: bool = True) -> dict[str, Any]:
    """Re-probe, dismiss any modal, focus the composer input and submit."""
    page, errors = best_page(cfg.cursor.port)
    if not page:
        return {"ok": False, "error": "no workbench page", "errors": errors}
    dismiss = dismiss_until_clear(cfg.cursor.port, timeout_s=8.0, poll=1.0)
    typed = try_focus_and_type(cfg.cursor.port, page, prompt, submit=submit)
    return {
        "ok": bool(typed.get("ok")),
        "dismiss": dismiss,
        "type": typed,
        "page": page,
        "errors": errors,
    }


# ------------------------------------------------------------------- poll ----
def poll_reply(
    cfg: Config, tracker: CompletionTracker, prev_limit_hits: set[str]
) -> dict[str, Any]:
    """One poll of reply/limit/logout state. Returns dict with 'state'."""
    page, errors = best_page(cfg.cursor.port)
    if not page:
        return {"state": "no_page", "errors": errors}

    s: CdpSession | None = None
    try:
        s = session_for(cfg.cursor.port, page)
        reply = s.evaluate(REPLY_JS) or {}
        limit_sample = s.evaluate(build_limit_js(cfg.detection)) or {}
        logout = s.evaluate(build_logout_js(cfg.detection)) or {}
    except Exception as e:  # noqa: BLE001
        if s:
            s.close()
        return {"state": "cdp_error", "errors": [str(e)], "reply": {}, "limit_sample": {}, "logout": {}}
    s.close()

    state, detail = tracker.update(reply)
    is_limit, why = classify_limit(
        limit_sample, prev_limit_hits, cfg.detection.limit_require_recent
    )
    if is_limit:
        state = "limit"
        detail = f"limit: {why}"
    if logout.get("loggedOut") and state not in ("done",):
        state = "logged_out"

    return {
        "state": state,
        "detail": detail,
        "reply": reply,
        "limit_sample": limit_sample,
        "logout": logout,
        "errors": errors,
    }


def evaluate_js(port: int, js: str) -> dict[str, Any]:
    """Run arbitrary JS on the best workbench page (detect-only / limit-sim)."""
    page, _ = best_page(port)
    if not page:
        return {"error": "no workbench page"}
    s = session_for(port, page)
    try:
        return s.evaluate(js) or {}
    finally:
        s.close()


INJECT_LIMIT_NODE_JS = r"""
(() => {
  const d = document.createElement('div');
  d.id = 'harness-limit-sim';
  d.innerText = "You've reached your usage limit. Please upgrade or wait.";
  d.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:#c00;color:#fff;padding:10px;font-size:16px;';
  document.body.appendChild(d);
  return true;
})()
"""


def inject_limit_node(port: int) -> dict[str, Any]:
    return evaluate_js(port, INJECT_LIMIT_NODE_JS)
