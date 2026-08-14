"""共享观察逻辑：读 runstate/events.jsonl + snapshot.json，计算运行状态与统计。

被 unattended/cli.py（status/stats/watch）与 loop 周期状态块复用，
保证统计口径一致。
"""
from __future__ import annotations

import datetime
import json
import time
from pathlib import Path

from .config import current_branch

BASE = Path(__file__).resolve().parent.parent
RUNSTATE = BASE / "unattended" / "runstate"
_cache = {"mtime": 0.0, "events": [], "path": ""}


def _slug(name: str) -> str:
    import re

    return re.sub(r'[\\/:*?"<>|]', "_", name).replace(" ", "_") or "default"


def _state_key(project: str) -> str:
    """runstate 目录 key：<项目名>@<分支名>（与 config.project_state_dir 一致）。"""
    p = Path(project)
    return _slug(f"{p.name}@{current_branch(p)}")


def events_path(project: str | None = None) -> Path:
    """events.jsonl for a (project, branch) pair; None = most recently active."""
    if project:
        return RUNSTATE / _state_key(project) / "events.jsonl"
    best, best_mt = RUNSTATE / "events.jsonl", 0.0  # 回退旧全局
    try:
        for p in RUNSTATE.glob("*/events.jsonl"):
            try:
                mt = p.stat().st_mtime
                if mt > best_mt:
                    best, best_mt = p, mt
            except Exception:
                pass
    except Exception:
        pass
    return best


def snapshot_path(project: str | None = None) -> Path:
    return events_path(project).with_name("snapshot.json")


def load_events(project: str | None = None) -> list[dict]:
    """Read events.jsonl (per project), cached by mtime."""
    p = events_path(project)
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


def load_snapshot(project: str | None = None) -> dict:
    try:
        return json.loads(snapshot_path(project).read_text(encoding="utf-8"))
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


def migrate_legacy() -> dict:
    """Split the old global runstate/events.jsonl into per-project dirs.

    Events are bucketed by the `project` field of each run_start; events after
    a run_start inherit that bucket. The old file is renamed to .legacy.jsonl.
    Returns {"projects": n, "events": n, "legacy": path}.
    """
    legacy = RUNSTATE / "events.jsonl"
    if not legacy.exists():
        return {"projects": 0, "events": 0, "legacy": None}
    buckets: dict[str, list[str]] = {}
    current: str | None = None
    total = 0
    for line in legacy.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        total += 1
        if e.get("event") == "run_start" and e.get("project"):
            # 旧全局日志无分支信息：归入 default 桶（= 非 git 项目的 key）
            current = _slug(f"{Path(e['project']).name}@default")
        if current:
            buckets.setdefault(current, []).append(line)
    for slug, lines in buckets.items():
        p = RUNSTATE / slug / "events.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    renamed = legacy.rename(legacy.with_suffix(".legacy.jsonl"))
    return {"projects": len(buckets), "events": total, "legacy": str(renamed)}


def build_status(project: str | None = None) -> dict:
    """Compute stats + recent events + queue from the runstate files.

    project: target project dir (its events/snapshot); None = most recent.
    """
    evs = load_events(project)
    snap = load_snapshot(project)
    st = {
        "switches": 0, "switch_ok": 0, "switch_failed": 0, "emails": [],
        "sends": 0, "tasks_done": 0, "tasks_start": 0, "extend_ok": 0,
        "run_start": None, "run_end": None, "run_end_kind": None,
        "mode": None, "project": None,
    }
    for e in evs:
        ev = e.get("event")
        if ev == "run_start":
            st["run_start"] = e.get("ts", 0)
            st["run_end"] = None  # 新一轮 run 开始，清除上一轮的结束标记
            st["run_end_kind"] = None
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
    queue = [
        {
            "text": t.get("text", "")[:70],
            "status": t.get("status"),
            "retries": t.get("retries", 0),
            "switch_reason": t.get("switch_reason"),
        }
        for t in snap.get("queue", [])
    ]
    return {
        "stats": st, "recent": recent, "queue": queue,
        "running": running, "now": fmt_ts(time.time()),
    }
