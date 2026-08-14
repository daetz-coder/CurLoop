"""GUI automation for the account switcher (换号助手, CursorLoginAssistant-836.exe).

Primary path: pyautogui image-template matching (refresh_cursor.png /
confirm_ok.png) with the assistant window moved onto the primary monitor and
DPI-awareness set. pywinauto UIA is an optional fallback behind a guarded
import (its comtypes typelib generation is flaky on this box).

`dry_run=True` locates windows/templates and reports coordinates but never
clicks or launches.
"""

from __future__ import annotations

import ctypes
import subprocess
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any

from .config import Config

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# z-order 置顶常量：HWND_TOPMOST=-1 / HWND_NOTOPMOST=-2。
# 换号期间把助手窗口置顶，防止全屏/最大化的终端窗口遮挡（Windows 前台锁会拒绝
# 后台进程 SetForegroundWindow 抢前台，但 HWND_TOPMOST 是显示层级、不依赖前台）。
_HWND_TOPMOST = -1
_HWND_NOTOPMOST = -2
_SWP_NOSIZE = 0x0001
_SWP_NOMOVE = 0x0002
_SWP_NOACTIVATE = 0x0010


def _set_topmost(hwnd: int, topmost: bool) -> None:
    """置顶/取消置顶窗口（不移动、不改变大小、不抢前台）。"""
    h = _HWND_TOPMOST if topmost else _HWND_NOTOPMOST
    user32.SetWindowPos(hwnd, h, 0, 0, 0, 0, _SWP_NOMOVE | _SWP_NOSIZE | _SWP_NOACTIVATE)


def _dpi_aware() -> None:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor aware
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass


def is_running(exe_name: str) -> bool:
    # tasklist /NH truncates the image name to 25 chars ("...836.exe" -> "...836."),
    # so match the stem, not the full "name.exe".
    stem = Path(exe_name).stem.lower()
    out = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/NH"],
        capture_output=True,
        text=True,
        check=False,
    )
    return stem in (out.stdout + out.stderr).lower()


# ---------------------------------------------------------------- windows ----
def find_windows(title_fragment: str) -> list[int]:
    """Visible top-level windows whose title contains `title_fragment`."""
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if title_fragment.lower() in buf.value.lower():
            found.append(int(hwnd))
        return True

    user32.EnumWindows(_cb, 0)
    return found


def _window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _pid_to_exe(pid: int) -> str | None:
    """Full image path of a process (PROCESS_QUERY_LIMITED_INFORMATION)."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(2048)
        size = wintypes.DWORD(2048)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        kernel32.CloseHandle(h)


def find_windows_for_exe(exe_path: Path | str) -> list[int]:
    """Visible top-level windows owned by a process whose exe path contains the
    given exe's stem. Title-independent: the assistant's window title may change
    between versions, but `CursorLoginAssistant-836.exe` does not."""
    stem = Path(exe_path).stem.lower()
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        exe = _pid_to_exe(_window_pid(hwnd)) or ""
        if stem in exe.lower():
            found.append(int(hwnd))
        return True

    user32.EnumWindows(_cb, 0)
    return found


def window_rect(hwnd: int) -> tuple[int, int, int, int]:
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def is_on_primary(x: int, y: int, w: int, h: int) -> bool:
    sw = user32.GetSystemMetrics(0)  # SM_CXSCREEN
    sh = user32.GetSystemMetrics(1)  # SM_CYSCREEN
    return not (x >= sw or x + w <= 0 or y >= sh or y + h <= 0)


def move_to_primary_and_foreground(hwnd: int) -> None:
    x, y, w, h = window_rect(hwnd)
    if not is_on_primary(x, y, w, h):
        user32.SetWindowPos(hwnd, 0, 100, 100, w, h, 0x0040)  # SWP_SHOWWINDOW
        time.sleep(0.4)
    # SW_RESTORE=9：还原最小化窗口（SW_SHOW=5 对最小化窗口无效，会导致
    # 窗口保持最小化 → 屏幕上没有内容 → 模板匹配必然失败）。
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    time.sleep(0.3)
    # 置顶：防止最大化/全屏终端遮挡助手窗口导致模板匹配失败。TOPMOST 是显示
    # 层级、不依赖前台（SetForegroundWindow 仍尝试，尽力激活）。
    _set_topmost(hwnd, True)
    time.sleep(0.5)  # 置顶后等窗口重绘完成，避免截到半绘制画面
    user32.SetForegroundWindow(hwnd)


# ---------------------------------------------------------------- clicking ----
def locate_template(template: Path, confidence: float, timeout_s: float, poll: float = 1.0) -> dict[str, Any]:
    """Find the template on the primary screen without clicking."""
    _dpi_aware()
    import pyautogui

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for conf in (confidence, max(0.7, confidence - 0.05)):
            for gray in (False, True):
                try:
                    box = pyautogui.locateOnScreen(str(template), confidence=conf, grayscale=gray)
                    if box:
                        # pyautogui may return numpy ints for template coordinates;
                        # coerce to plain int so the report is JSON-serializable.
                        l, t, w, h = int(box.left), int(box.top), int(box.width), int(box.height)
                        return {
                            "ok": True,
                            "box": [l, t, w, h],
                            "center": [l + w // 2, t + h // 2],
                            "confidence": conf,
                            "grayscale": gray,
                        }
                except pyautogui.ImageNotFoundException:
                    pass
        time.sleep(poll)
    return {"ok": False, "reason": "template not found on screen"}


def click_template(template: Path, confidence: float, timeout_s: float, poll: float = 1.0) -> dict[str, Any]:
    import pyautogui

    loc = locate_template(template, confidence, timeout_s, poll)
    if not loc.get("ok"):
        return loc
    cx, cy = loc["center"]
    pyautogui.click(cx, cy)
    return {**loc, "clicked": True}


def _click_by_uia(title_re: str, button_re: str) -> dict[str, Any]:
    """Optional fallback: find the button by accessible name via pywinauto."""
    try:
        import comtypes.client

        gen = Path.home() / ".comtypes-gen"
        gen.mkdir(parents=True, exist_ok=True)
        comtypes.client.gen_dir = str(gen)
        from pywinauto import Application
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"pywinauto unavailable: {e}"}
    try:
        app = Application(backend="uia").connect(title_re=title_re)
        dlg = app.top_window()
        btn = dlg.child_window(title_re=button_re, control_type="Button")
        if btn.exists(timeout=3):
            btn.click()
            return {"ok": True, "method": "pywinauto", "button": button_re}
        return {"ok": False, "reason": "button not found via UIA"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"pywinauto error: {e}"}


# ---------------------------------------------------------------- refresh ----
_ASSISTANT_TITLE_FRAGMENTS = ("Cursor 登录助手", "登录助手", "CursorLoginAssistant")


def _assistant_like_titles() -> list[str]:
    """Visible window titles that look assistant-related, for diagnostics when
    the window cannot be found (avoids blind retries / wrong-window screenshots)."""
    hints = ("cursor", "登录", "助手", "assistant", "login", "换号")
    found: list[str] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        low = buf.value.lower()
        if any(h in low for h in hints):
            found.append(buf.value)
        return True

    user32.EnumWindows(_cb, 0)
    return found


def _find_assistant_window(exe_path: Path, timeout_s: float) -> tuple[int | None, list[str]]:
    """Poll for the assistant's window (Electron cold start is slow).

    Tries, in order: windows owned by the assistant exe (title-independent),
    then known title fragments. Returns `(hwnd, seen_titles)`; `seen_titles`
    holds assistant-like window titles collected while polling, for diagnostics
    when nothing matches.
    """
    deadline = time.time() + timeout_s
    seen: list[str] = []
    while time.time() < deadline:
        wins = find_windows_for_exe(exe_path)
        if wins:
            return wins[0], seen
        for frag in _ASSISTANT_TITLE_FRAGMENTS:
            wins = find_windows(frag)
            if wins:
                return wins[0], seen
        if not seen:
            seen = _assistant_like_titles()
        time.sleep(2)
    return None, seen


def refresh_account(cfg: Config, dry_run: bool = False) -> dict[str, Any]:
    """Launch (if needed) the assistant, bring it to the primary monitor, click
    刷新Cursor, then dismiss the confirm dialog. Returns a step report.

    Token-change detection is done by the caller (loop.py), never here.
    """
    _dpi_aware()
    la = cfg.login_assistant
    result: dict[str, Any] = {"ok": False, "steps": []}
    exe_name = la.exe.name

    # 1. Ensure the process is up (77MB Electron cold start can take >15s).
    launched = False
    launch_error: str | None = None
    proc: subprocess.Popen | None = None
    if not is_running(exe_name):
        if dry_run:
            result["steps"].append({"step": "launch", "ok": False, "would_launch": True})
            result["steps"].append({"step": "window", "ok": False, "reason": "assistant not running (dry-run won't launch)"})
            return result
        try:
            proc = subprocess.Popen(
                [str(la.exe)],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            launched = True
        except Exception as e:  # noqa: BLE001  (e.g. WinError 740 when not elevated)
            launch_error = str(e)
    deadline = time.time() + (la.launch_wait_s if launched else 3.0)
    up = is_running(exe_name)
    exited_early: int | None = None
    while not up and time.time() < deadline:
        time.sleep(2)
        up = is_running(exe_name)
        if proc is not None and proc.poll() is not None and exited_early is None:
            exited_early = proc.returncode
    if launch_error:
        result["steps"].append({"step": "launch", "ok": False, "launched": False, "error": launch_error})
        return result
    result["steps"].append(
        {"step": "launch", "ok": up, "launched": launched, "wait_s": la.launch_wait_s, "exited_early": exited_early}
    )
    if not up:
        result["steps"].append({"step": "window", "ok": False, "reason": "assistant process did not start"})
        return result

    # 2. Find the window (title is Chinese "Cursor 登录助手").
    hwnd, seen_titles = _find_assistant_window(la.exe, la.launch_wait_s)
    if not hwnd:
        result["steps"].append(
            {
                "step": "window",
                "ok": False,
                "reason": "assistant window not found",
                "process_running": is_running(exe_name),
                "visible_assistant_like_titles": seen_titles,
            }
        )
        return result
    result["steps"].append({"step": "window", "ok": True, "hwnd": hwnd})
    if not dry_run:
        move_to_primary_and_foreground(hwnd)

    # 3. Click 刷新Cursor.
    refresh = locate_template(la.refresh_template, la.confidence, timeout_s=la.confirm_wait_s, poll=0.5)
    if not refresh.get("ok"):
        refresh = _click_by_uia(r".*登录助手.*|.*Cursor.*", r".*刷新.*|.*Refresh.*")
    elif not dry_run:
        import pyautogui

        pyautogui.click(*refresh["center"])
        refresh["clicked"] = True
    result["steps"].append({"step": "refresh", **refresh})

    # 4. Confirm dialog.
    # 点击刷新后确认模态框是独立的顶层窗口（Qt QDialog），主窗口置顶不保证它
    # 可见；等它弹出后把助手进程的所有窗口都置顶，防止被最大化终端遮挡。
    if not dry_run:
        time.sleep(1.5)
        try:
            for w in find_windows_for_exe(la.exe):
                _set_topmost(w, True)
        except Exception:  # noqa: BLE001
            pass
    confirm: dict[str, Any] = {"ok": False, "reason": "no confirm template configured"}
    if la.confirm_template and la.confirm_template.exists():
        confirm = locate_template(la.confirm_template, la.confidence, timeout_s=la.confirm_wait_s, poll=0.5)
        if confirm.get("ok") and not dry_run:
            import pyautogui

            pyautogui.click(*confirm["center"])
            confirm["clicked"] = True
    result["steps"].append({"step": "confirm", **confirm})

    result["ok"] = bool(refresh.get("ok"))

    # 5. Close the assistant (WM_CLOSE first, force-kill as fallback) unless
    #    configured off. A lingering assistant window occludes the screen and
    #    confuses the next find_windows.
    if la.close_after_refresh and not dry_run:
        closed = close_assistant(la.exe)
        result["steps"].append({"step": "close", **closed})
    elif not dry_run:
        # 助手常驻（close_after_refresh=false）时不解除置顶会一直盖着屏幕；
        # 换号动作已完成，token 变化检测与窗口层级无关，解除置顶安全。
        try:
            _set_topmost(hwnd, False)
        except Exception:  # noqa: BLE001
            pass
    return result


def close_assistant(exe_path: Path, timeout_s: float = 5.0) -> dict[str, Any]:
    """Politely close the assistant (WM_CLOSE), then force-kill if it lingers."""
    exe_name = exe_path.name
    wins = find_windows_for_exe(exe_path)
    sent = 0
    for hwnd in wins:
        user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
        sent += 1
    deadline = time.time() + timeout_s
    while time.time() < deadline and is_running(exe_name):
        time.sleep(0.5)
    force_killed = False
    if is_running(exe_name):
        ps = (
            'Get-CimInstance Win32_Process -Filter "Name = \'{0}\'" | ForEach-Object {{ '
            "try {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }} catch {{}} }}"
        ).format(exe_name)
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            check=False,
        )
        time.sleep(1.0)
        force_killed = True
    return {"ok": not is_running(exe_name), "wm_close_sent": sent, "force_killed": force_killed}
