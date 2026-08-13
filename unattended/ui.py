"""终端显示：ANSI 配色 + status/stats 渲染（零依赖）。

Windows 下用 os.system("") 启用 VT 转义；非 TTY（管道/日志）自动降级为纯文本。
"""
from __future__ import annotations

import os
import sys

_ANSI = True


def init() -> None:
    """Enable ANSI escape processing (Windows 10+); disable when not a TTY."""
    global _ANSI
    if os.name == "nt":
        try:
            os.system("")  # noqa: S605 -- enables VT processing on Windows consoles
        except Exception:
            pass
    _ANSI = sys.stdout.isatty() if hasattr(sys.stdout, "isatty") else True


class C:
    R = "\033[0m"
    B = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    GRAY = "\033[90m"


def paint(text: str, color: str = "", bold: bool = False) -> str:
    if not _ANSI or not color:
        return text
    code = color + (C.B if bold else "")
    return f"{code}{text}{C.R}"


def ok(text: str) -> str:
    return paint(text, C.GREEN)


def warn(text: str) -> str:
    return paint(text, C.YELLOW)


def err(text: str) -> str:
    return paint(text, C.RED)


def head(text: str) -> str:
    return paint(text, C.CYAN, bold=True)


def num(text: str) -> str:
    return paint(text, C.MAGENTA, bold=True)


def dim(text: str) -> str:
    return paint(text, C.GRAY)


def _line(char: str = "─", width: int = 60) -> str:
    return dim(char * width)


def status_render(d: dict) -> str:
    s = d["stats"]
    L: list[str] = []
    add = L.append
    add(head("╔═ CursorHarness · 观察状态 ") + dim("═" * 24) + head(" ═╗"))
    add(f"  {dim('项目')}   {s.get('project') or '-'}")
    mode = s.get("mode") or "-"
    add(f"  {dim('模式')}   {ok(mode) if mode == 'live' else warn(mode)}    {dim('已运行')} {num(d.get('running') or '-')}    {dim('刷新')} {d.get('now')}")
    add(_line())
    add(f"  {head('换号')}  {num(str(s['switches']))}   {ok('成功 ' + str(s['switch_ok']))}   {err('失败 ' + str(s['switch_failed']))}")
    if s["emails"]:
        add(f"  {dim('账号')}   {paint(', '.join(s['emails'][-3:]), C.CYAN)}")
    add(f"  {head('对话')}  {num(str(s['sends']))} 发送   {ok(str(s['tasks_done']))} 完成   {paint(str(s['extend_ok']), C.YELLOW)} 自动续接")
    add(_line())
    add(f"  {head('TODO 队列')}  {dim('(' + str(len(d['queue'])) + ')')}")
    if not d["queue"]:
        add(f"  {dim('   （空）')}")
    for q in d["queue"]:
        st = q.get("status")
        mark = {"done": ok("✓ done"), "running": warn("▶ running"), "pending": dim("○ pending"), "skipped": err("✗ skipped")}.get(st, dim(st))
        add(f"   {mark}  {q.get('text', '')[:64]}")
    add(_line())
    add(f"  {head('最近事件')}  {dim('(最多 10 条)')}")
    for e in d["recent"][:10]:
        ev = e.get("event") or ""
        if "fail" in ev or "error" in ev:
            evc = err(ev)
        elif "done" in ev or "ok" in ev:
            evc = ok(ev)
        elif "sent" in ev or "start" in ev:
            evc = paint(ev, C.CYAN)
        else:
            evc = dim(ev)
        add(f"   {dim(e.get('t', ''))}  {evc:<24} {e.get('detail', '')[:44]}")
    add(head("╚" + "═" * 58 + "╝"))
    return "\n".join(L)


def stats_render(s: dict) -> str:
    parts = [
        f"{head('换号')} {num(str(s['switches']))}",
        f"{ok(str(s['switch_ok']))} 成功 / {err(str(s['switch_failed']))} 失败",
        f"{head('对话')} {num(str(s['sends']))}",
        f"{head('完成')} {ok(str(s['tasks_done']))}",
        f"{head('续接')} {warn(str(s['extend_ok']))}",
    ]
    out = "  ".join(parts)
    if s["emails"]:
        out += f"\n{dim('账号')}  {paint(', '.join(s['emails']), C.CYAN)}"
    return out
