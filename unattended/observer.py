"""共享观察逻辑：读 runstate/events.jsonl + snapshot.json，计算运行状态与统计。

被 unattended/cli.py（status/stats/watch）与 loop 周期状态块复用，
保证统计口径一致。

runstate 根目录与 Config.state_dir 同源（默认 %APPDATA%\\curloop\\runstate）。
"""
from __future__ import annotations

import datetime
import json
import time
from pathlib import Path

from .config import USER_CONFIG_DIR, current_branch

_cache = {"mtime": 0.0, "events": [], "path": ""}


def _slug(name: str) -> str:
    import re

    return re.sub(r'[\\/:*?"<>|]', "_", name).replace(" ", "_") or "default"


def _state_key(project: str) -> str:
    """runstate 目录 key：<项目名>@<分支名>（与 config.project_state_dir 一致）。"""
    p = Path(project)
    return _slug(f"{p.name}@{current_branch(p)}")


def runstate_root(state_dir: Path | None = None) -> Path:
    """默认与 Config.state_dir 一致：%APPDATA%\\curloop\\runstate。"""
    return Path(state_dir) if state_dir is not None else (USER_CONFIG_DIR / "runstate")


def events_path(project: str | None = None, state_dir: Path | None = None) -> Path:
    """events.jsonl for a (project, branch) pair; None = most recently active."""
    root = runstate_root(state_dir)
    if project:
        return root / _state_key(project) / "events.jsonl"
    best, best_mt = root / "events.jsonl", 0.0  # 回退旧全局
    try:
        for p in root.glob("*/events.jsonl"):
            try:
                mt = p.stat().st_mtime
                if mt > best_mt:
                    best, best_mt = p, mt
            except Exception:
                pass
    except Exception:
        pass
    return best


def snapshot_path(project: str | None = None, state_dir: Path | None = None) -> Path:
    return events_path(project, state_dir=state_dir).with_name("snapshot.json")


def load_events(project: str | None = None, state_dir: Path | None = None) -> list[dict]:
    """Read events.jsonl (per project), cached by mtime."""
    p = events_path(project, state_dir=state_dir)
    try:
        mt = p.stat().st_mtime
        if mt != _cache["mtime"] or str(p) != _cache["path"]:
            evs: list[dict] = []
            with p.open(encoding="utf-8") as fh:
                for line in fh:
                    try:
                        evs.append(json.loads(line))
                    except Exception:
                        pass
            _cache.update(mtime=mt, events=evs, path=str(p))
        return _cache["events"]
    except Exception:
        return _cache["events"]


def load_snapshot(project: str | None = None, state_dir: Path | None = None) -> dict:
    try:
        return json.loads(snapshot_path(project, state_dir=state_dir).read_text(encoding="utf-8"))
    except Exception:
        return {}


def fmt_ts(ts: float) -> str:
    try:
        return datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S")
    except Exception:
        return "?"


def short_detail(e: dict) -> str:
    for k in ("detail", "reason", "task"):
        v = e.get(k)
        if v:
            return str(v)[:80]
    return ""


def _todo_aligned_queue(project: str | None, snap: dict, state_dir: Path | None = None) -> list[dict]:
    """状态展示的队列与 RunState.load 的 done 过滤对齐。

    快照里的任务若在当前 TODO.md 已勾选（[x]），标记 done——否则状态块显示
    pending/running 而真实内存队列在 load() 里已把它们过滤（误导：看起来有
    任务可跑，实际队列空）。读最近 run_start 事件的 todo 字段定位 TODO.md；
    无 todo 信息或文件缺失时原样返回快照队列。
    """
    raw = snap.get("queue", [])
    if not raw:
        return []
    todo: Path | None = None
    for e in load_events(project, state_dir=state_dir):
        if e.get("event") == "run_start" and e.get("todo"):
            todo = Path(e["todo"])
            break
    if not todo or not todo.exists():
        return [
            {
                "text": t.get("text", "")[:70],
                "status": t.get("status"),
                "retries": t.get("retries", 0),
                "switch_reason": t.get("switch_reason"),
            }
            for t in raw
        ]
    from .todo_queue import _norm, parse_all

    done_norms = {t.normalized() for t in parse_all(todo) if t.done}
    out = []
    for t in raw:
        full = t.get("text", "")
        item = {
            "text": full[:70],
            "status": t.get("status"),
            "retries": t.get("retries", 0),
            "switch_reason": t.get("switch_reason"),
        }
        if item["status"] != "done" and _norm(full) in done_norms:
            item["status"] = "done"
        out.append(item)
    return out


def build_status(
    project: str | None = None,
    state_dir: Path | None = None,
) -> dict:
    """Compute stats + recent events + queue from the runstate files.

    project: target project dir (its events/snapshot); None = most recent.
    state_dir: runstate root (default %APPDATA%\\curloop\\runstate).
    """
    evs = load_events(project, state_dir=state_dir)
    snap = load_snapshot(project, state_dir=state_dir)
    st = {
        "switches": 0, "switch_ok": 0, "switch_failed": 0, "emails": [],
        "sends": 0, "tasks_done": 0, "tasks_start": 0, "extend_ok": 0,
        "run_start": None, "run_end": None, "run_end_kind": None,
        "mode": None, "project": None,
    }
    for e in evs:
        ev = e.get("event")
        if ev == "run_start":
            # 每次 run 独立统计：新一轮 run 开始重置所有计数（换号/对话/完成/
            # 账号），不跨 run 累计——用户要求每次开启对话的统计互不混用。
            st = {
                "switches": 0, "switch_ok": 0, "switch_failed": 0, "emails": [],
                "sends": 0, "tasks_done": 0, "tasks_start": 0, "extend_ok": 0,
                "run_start": None, "run_end": None, "run_end_kind": None,
                "mode": None, "project": None,
            }
            st["run_start"] = e.get("ts", 0)
            st["mode"] = e.get("mode")
            st["project"] = e.get("project")
        elif ev in ("interrupt", "run_done", "run_abort"):
            st["run_end"] = e.get("ts", 0)
            st["run_end_kind"] = ev
        elif ev == "switch_start":
            st["switches"] += 1
        elif ev == "switch_ok":
            st["switch_ok"] += 1
            if e.get("email"):
                st["emails"].append(e["email"])
        elif ev == "switch_failed":
            st["switch_failed"] += 1
        elif ev == "sent":
            st["sends"] += 1
        elif ev == "task_done":
            st["tasks_done"] += 1
        elif ev == "task_start":
            st["tasks_start"] += 1
        elif ev == "extend_result" and e.get("new_tasks", 0) > 0:
            st["extend_ok"] += 1

    running = "-"
    if st["run_start"]:
        if st["run_end"]:
            kinds = {"interrupt": "中断", "run_done": "完成", "run_abort": "中止"}
            running = f"已停止({kinds.get(st['run_end_kind'], st['run_end_kind'])})"
        else:
            running = f"{int(time.time() - st['run_start'])}s"

    recent = [
        {"t": fmt_ts(e.get("ts", 0)), "event": e.get("event"), "detail": short_detail(e)}
        for e in reversed(evs[-30:])
    ]
    queue = _todo_aligned_queue(project, snap, state_dir=state_dir)
    return {
        "stats": st, "recent": recent, "queue": queue,
        "running": running, "now": fmt_ts(time.time()),
    }
