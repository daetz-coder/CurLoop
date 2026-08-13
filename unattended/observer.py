"""共享观察逻辑：读 runstate/events.jsonl + snapshot.json，计算运行状态与统计。

被 dashboard.py（Web 面板）与 unattended/cli.py（status/stats/watch）复用，
保证统计口径一致。
"""
from __future__ import annotations

import datetime
import json
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
EVENTS = BASE / "unattended" / "runstate" / "events.jsonl"
SNAPSHOT = BASE / "unattended" / "runstate" / "snapshot.json"

_cache = {"mtime": 0.0, "events": []}


def load_events() -> list[dict]:
    """Read events.jsonl, cached by mtime (the file grows while a run is active)."""
    try:
        mt = EVENTS.stat().st_mtime
        if mt != _cache["mtime"]:
            evs: list[dict] = []
            with EVENTS.open(encoding="utf-8") as fh:
                for line in fh:
                    try:
                        evs.append(json.loads(line))
                    except Exception:
                        pass
            _cache.update(mtime=mt, events=evs)
        return _cache["events"]
    except Exception:
        return _cache["events"]


def load_snapshot() -> dict:
    try:
        return json.loads(SNAPSHOT.read_text(encoding="utf-8"))
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


def build_status() -> dict:
    """Compute stats + recent events + queue from the runstate files."""
    evs = load_events()
    snap = load_snapshot()
    st = {
        "switches": 0, "switch_ok": 0, "switch_failed": 0, "emails": [],
        "sends": 0, "tasks_done": 0, "tasks_start": 0, "extend_ok": 0,
        "run_start": None, "mode": None, "project": None,
    }
    for e in evs:
        ev = e.get("event")
        if ev == "run_start":
            st["run_start"] = e.get("ts", 0)
            st["mode"] = e.get("mode")
            st["project"] = e.get("project")
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

    running = ""
    if st["run_start"]:
        running = f"{int(time.time() - st['run_start'])}s"

    recent = [
        {"t": fmt_ts(e.get("ts", 0)), "event": e.get("event"), "detail": short_detail(e)}
        for e in reversed(evs[-30:])
    ]
    queue = [
        {"text": t.get("text", "")[:70], "status": t.get("status")}
        for t in snap.get("queue", [])
    ]
    return {
        "stats": st, "recent": recent, "queue": queue,
        "running": running, "now": fmt_ts(time.time()),
    }
