"""
Unattended resume after Cursor auth is present.

Does NOT drive third-party account-switcher UIs.
Assumes tokens were already injected into a Cursor user-data-dir
(or will appear there). Then:

  wait auth-ready → (re)launch Cursor with CDP → dismiss → chat → wait reply

Auth readiness is detected from:
  1) %APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb  (or custom profile)
  2) CDP DOM no longer showing the logged-out gate
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

# Reuse CDP helpers from prior harness
sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_cdp import (  # noqa: E402
    CURSOR_EXE,
    CdpSession,
    launch_cursor,
    list_targets,
    probe_pages,
    try_dismiss,
    try_focus_and_type,
    wait_cdp,
)

DEFAULT_PORT = 9333
DEFAULT_PROFILE = Path(__file__).resolve().parent / ".harness-profile"
ROAMING_CURSOR = Path.home() / "AppData" / "Roaming" / "Cursor"


AUTH_GATE_JS = r"""
(() => {
  const text = ((document.body && document.body.innerText) || '');
  const lower = text.toLowerCase();
  const loggedOut =
    /require you to be logged in/i.test(text) ||
    /sign up/i.test(text) && /log in/i.test(lower) && /cursor.?s ai features/i.test(lower) ||
    /需要登录/.test(text);
  const inputs = document.querySelectorAll(
    '.aislash-editor-input, [data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"]'
  );
  let inputVisible = false;
  inputs.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 80 && r.height > 12) inputVisible = true;
  });
  return {
    loggedOut,
    inputVisible,
    title: document.title,
    sampleTail: text.slice(-500),
  };
})()
"""


def http_ok(url: str, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def state_db_path(user_data_dir: Path) -> Path:
    return user_data_dir / "User" / "globalStorage" / "state.vscdb"


def read_auth_from_db(db_path: Path) -> dict[str, Any]:
    """Read-only peek at Cursor auth keys. Never prints full tokens."""
    out: dict[str, Any] = {
        "db_exists": db_path.exists(),
        "has_access_token": False,
        "has_refresh_token": False,
        "email": None,
        "access_fp": None,
    }
    if not db_path.exists():
        return out
    uri = f"file:{db_path}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
        return out
    try:
        cur = conn.cursor()
        wanted = (
            "cursorAuth/accessToken",
            "cursorAuth/refreshToken",
            "cursorAuth/cachedEmail",
            "cursorAuth/cachedSignUpType",
        )
        rows = {}
        for key in wanted:
            cur.execute("SELECT value FROM ItemTable WHERE key = ? LIMIT 1", (key,))
            row = cur.fetchone()
            if row and row[0]:
                rows[key] = row[0]
        token = rows.get("cursorAuth/accessToken") or ""
        out["has_access_token"] = bool(token) and token.startswith("eyJ")
        out["has_refresh_token"] = bool(rows.get("cursorAuth/refreshToken"))
        out["email"] = rows.get("cursorAuth/cachedEmail")
        if token:
            out["access_fp"] = f"{token[:12]}…{token[-8:]}(len={len(token)})"
        return out
    finally:
        conn.close()


def kill_cursor_for_profile(user_data_dir: Path) -> None:
    """Best-effort: stop Cursor processes started with this user-data-dir."""
    needle = str(user_data_dir).lower()
    try:
        import wmi  # type: ignore

        _ = wmi
    except Exception:
        pass
    # PowerShell filter by CommandLine
    ps = f"""
$needle = '{needle}'.ToLower()
Get-CimInstance Win32_Process -Filter \"Name = 'Cursor.exe'\" | ForEach-Object {{
  if ($_.CommandLine -and $_.CommandLine.ToLower().Contains($needle)) {{
    try {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }} catch {{}}
  }}
}}
"""
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True,
        text=True,
        check=False,
    )
    time.sleep(1.5)


def wait_auth_in_db(user_data_dir: Path, timeout_s: float, poll: float = 1.0) -> dict[str, Any]:
    db = state_db_path(user_data_dir)
    deadline = time.time() + timeout_s
    last: dict[str, Any] = {}
    while time.time() < deadline:
        last = read_auth_from_db(db)
        print(f"[auth-db] exists={last.get('db_exists')} token={last.get('has_access_token')} email={last.get('email')}")
        if last.get("has_access_token"):
            return last
        time.sleep(poll)
    return last


def best_page(port: int):
    pages, errors = probe_pages(port)
    if not pages:
        return None, errors
    pages = sorted(pages, key=lambda p: int((p.get("probe") or {}).get("inputCount") or 0), reverse=True)
    return pages[0], errors


def session_for(port: int, page: dict) -> CdpSession:
    targets = list_targets(port)
    target = next((t for t in targets if t.get("id") == page.get("targetId")), None)
    if not target:
        raise RuntimeError("CDP target missing")
    s = CdpSession(target["webSocketDebuggerUrl"])
    s.call("Runtime.enable")
    return s


def wait_dom_logged_in(port: int, timeout_s: float) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    last: dict[str, Any] = {}
    while time.time() < deadline:
        page, _ = best_page(port)
        if not page:
            time.sleep(1.5)
            continue
        s = session_for(port, page)
        try:
            last = s.evaluate(AUTH_GATE_JS) or {}
        finally:
            s.close()
        print(
            f"[auth-dom] loggedOut={last.get('loggedOut')} input={last.get('inputVisible')} title={last.get('title')!r}"
        )
        if last.get("inputVisible") and not last.get("loggedOut"):
            last["page"] = page
            return last
        # Soft success: input visible even if marketing text still mentions login somewhere
        if last.get("inputVisible") and "require you to be logged in" not in (last.get("sampleTail") or "").lower():
            last["page"] = page
            return last
        time.sleep(2.0)
    return last


REPLY_JS = r"""
(() => {
  const text = ((document.body && document.body.innerText) || '');
  const generating = /stop generating|停止|generating|thinking/i.test(text);
  const pairs = [...document.querySelectorAll(
    '.composer-human-ai-pair-container, .anysphere-markdown-container-root, [data-message-kind]'
  )].map(el => ((el.innerText || '') + '').trim().slice(0, 500));
  return {
    generating,
    pairCount: pairs.length,
    pairs: pairs.slice(-6),
    hasMarker: text.includes('HARNESS_RESUME_OK'),
    loggedOut: /require you to be logged in/i.test(text),
    tail: text.slice(-800),
  };
})()
"""


def run_conversation(port: int, prompt: str, timeout_s: float = 180.0) -> dict[str, Any]:
    page, errors = best_page(port)
    result: dict[str, Any] = {"ok": False, "errors": errors, "steps": []}
    if not page:
        result["errors"].append("no workbench page")
        return result

    dismiss = try_dismiss(port, page)
    result["steps"].append({"dismiss": dismiss})

    typed = try_focus_and_type(port, page, prompt, submit=True)
    result["steps"].append({"send": typed})
    if not typed.get("ok"):
        result["errors"].append("send failed")
        return result

    deadline = time.time() + timeout_s
    last = None
    saw_gen = False
    while time.time() < deadline:
        time.sleep(2.0)
        page2, _ = best_page(port)
        if not page2:
            continue
        s = session_for(port, page2)
        try:
            last = s.evaluate(REPLY_JS)
        finally:
            s.close()
        if last.get("generating"):
            saw_gen = True
        print(
            f"[reply] gen={last.get('generating')} pairs={last.get('pairCount')} "
            f"marker={last.get('hasMarker')} loggedOut={last.get('loggedOut')}"
        )
        if last.get("loggedOut"):
            result["errors"].append("logged out during chat")
            break
        if last.get("hasMarker") and (saw_gen or last.get("pairCount", 0) > 0):
            # Prefer marker appearing outside the prompt echo
            tail = last.get("tail") or ""
            if tail.count("HARNESS_RESUME_OK") >= 1 and (
                saw_gen or "Reply with exactly" in tail and tail.rfind("HARNESS_RESUME_OK") > tail.find("Reply with exactly")
            ):
                result["ok"] = True
                break
        if saw_gen and not last.get("generating") and last.get("pairCount", 0) > 0:
            result["ok"] = True
            break

    result["steps"].append({"after": last, "saw_generating": saw_gen})
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Resume Cursor chat after auth injection, unattended")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument(
        "--profile",
        type=Path,
        default=DEFAULT_PROFILE,
        help="Cursor --user-data-dir that received the injected session",
    )
    ap.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parent)
    ap.add_argument("--wait-auth", type=float, default=180.0, help="Seconds to wait for state.vscdb token")
    ap.add_argument("--wait-dom", type=float, default=120.0)
    ap.add_argument("--relaunch", action="store_true", help="Kill profile Cursor and launch with CDP")
    ap.add_argument(
        "--prompt",
        default="Reply with exactly: HARNESS_RESUME_OK. No other text.",
    )
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "verify-resume.json")
    ap.add_argument(
        "--skip-chat",
        action="store_true",
        help="Only wait auth + CDP ready; do not send a prompt",
    )
    args = ap.parse_args()

    report: dict[str, Any] = {
        "ok": False,
        "profile": str(args.profile),
        "port": args.port,
        "phases": {},
    }

    print(f"[..] waiting for auth in profile DB: {state_db_path(args.profile)}")
    auth = wait_auth_in_db(args.profile, timeout_s=args.wait_auth)
    report["phases"]["auth_db"] = auth
    if not auth.get("has_access_token"):
        # Also check default roaming if profile is empty (injection target sometimes differs)
        roaming = read_auth_from_db(state_db_path(ROAMING_CURSOR))
        report["phases"]["auth_db_roaming"] = {
            k: roaming[k] for k in ("db_exists", "has_access_token", "email", "access_fp") if k in roaming
        }
        print(
            "[fail] No accessToken in harness profile yet.\n"
            "       Ensure LoginAssistant injects into THIS --user-data-dir,\n"
            "       or pass --profile to the injected Cursor data directory."
        )
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return 2

    cdp_up = http_ok(f"http://127.0.0.1:{args.port}/json/version")
    if args.relaunch or not cdp_up:
        print("[..] relaunching Cursor with CDP (injection often restarts without debug port)")
        kill_cursor_for_profile(args.profile)
        if not CURSOR_EXE.exists():
            print(f"[fail] missing {CURSOR_EXE}")
            return 2
        proc = launch_cursor(args.port, args.profile, args.workspace)
        report["phases"]["launch_pid"] = proc.pid
        try:
            version = wait_cdp(args.port, timeout_s=90)
            report["phases"]["cdp_version"] = version.get("Browser")
            print(f"[ok] CDP ready: {version.get('Browser')}")
        except Exception as e:  # noqa: BLE001
            report["phases"]["cdp_error"] = str(e)
            args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[fail] {e}")
            return 2
    else:
        print(f"[ok] CDP already up on {args.port}")

    print("[..] waiting for DOM logged-in / chat input")
    dom = wait_dom_logged_in(args.port, timeout_s=args.wait_dom)
    report["phases"]["auth_dom"] = {k: v for k, v in dom.items() if k != "page"}
    if not dom.get("inputVisible") or dom.get("loggedOut"):
        print("[fail] Chat UI still gated / no input")
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1

    if args.skip_chat:
        report["ok"] = True
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[ok] auth+CDP ready (chat skipped)")
        return 0

    print("[..] sending prompt and waiting for reply")
    chat = run_conversation(args.port, args.prompt)
    report["phases"]["chat"] = chat
    report["ok"] = bool(chat.get("ok"))
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": report["ok"]}, ensure_ascii=False))
    print("=>", args.out)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
