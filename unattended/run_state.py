"""Persistent run state: snapshot.json (crash resume) + events.jsonl (append log)."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

from .todo_queue import TodoTask, parse_all

# events.jsonl 超过此大小则轮转（当前 → .1 → .2 …），避免长跑无限膨胀。
_MAX_EVENT_LOG_BYTES = 5 * 1024 * 1024  # 5 MiB
_EVENT_LOG_KEEP = 3


def _rotate_event_log(path: Path) -> None:
    """若当前日志过大，轮转为 path.1 … path.N（覆盖最旧）。"""
    try:
        if not path.exists() or path.stat().st_size < _MAX_EVENT_LOG_BYTES:
            return
    except OSError:
        return
    for i in range(_EVENT_LOG_KEEP, 0, -1):
        src = path if i == 1 else path.with_name(f"{path.name}.{i - 1}")
        dst = path.with_name(f"{path.name}.{i}")
        try:
            if not src.exists():
                continue
            if dst.exists():
                dst.unlink()
            src.replace(dst)
        except OSError as e:
            print(f"[warn] event log rotate failed: {e}", file=sys.stderr)
            return


class RunState:
    def __init__(self, snapshot_file: Path, event_log_file: Path, queue: list[TodoTask]):
        self.snapshot_file = snapshot_file
        self.event_log_file = event_log_file
        self.queue = queue
        self.switches_used = 0
        self.cooldown_until = 0.0
        self.events_written = 0
        self.cdp_browser: str | None = None
        self.started_at = time.time()

    # ------------------------------------------------------------------ log
    def log(self, event: str, **fields: Any) -> None:
        row = {"ts": time.time(), "event": event, **fields}
        self.event_log_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            _rotate_event_log(self.event_log_file)
            with self.event_log_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
            self.events_written += 1
        except OSError as e:  # disk full / perms — never lose the run silently
            print(f"[warn] event log append failed: {e}", file=sys.stderr)
        line = " ".join(f"{k}={v}" for k, v in fields.items())
        print(f"[{event}] {line}")

    # ------------------------------------------------------------- snapshot
    def save(self) -> None:
        snap = {
            "version": 1,
            "started_at": self.started_at,
            "switches_used": self.switches_used,
            "cooldown_until": self.cooldown_until,
            "events_written": self.events_written,
            "cdp_browser": self.cdp_browser,
            "queue": [t.to_dict() for t in self.queue],
        }
        self.snapshot_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.snapshot_file.with_name(self.snapshot_file.name + ".tmp")
        tmp.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.snapshot_file)

    def next_task(self) -> TodoTask | None:
        """First pending task (in-flight 'running' is resumed as pending)."""
        for t in self.queue:
            if t.status in ("pending", "running"):
                if t.status == "running":
                    t.status = "pending"
                return t
        return None

    # --------------------------------------------------------------- resume
    @classmethod
    def load(cls, snapshot_file: Path, event_log_file: Path, todo_file: Path) -> "RunState":
        fresh = parse_all(todo_file)
        fresh_unchecked = [t for t in fresh if not t.done]
        fresh_done_norms = {t.normalized() for t in fresh if t.done}
        fresh_unchecked_norms = {t.normalized() for t in fresh_unchecked}

        st = cls(snapshot_file, event_log_file, [])
        if not snapshot_file.exists():
            st.queue = fresh_unchecked
            return st

        try:
            snap = json.loads(snapshot_file.read_text(encoding="utf-8"))
        except Exception:
            st.queue = fresh_unchecked
            return st

        snap_tasks = [TodoTask.from_dict(x) for x in snap.get("queue", [])]

        # Mark snapshot tasks done if they are now checked in TODO.md
        # (completed by us earlier, or checked manually while we were away).
        for t in snap_tasks:
            if t.status != "done" and t.normalized() in fresh_done_norms:
                t.status = "done"
                t.done = True

        known_norms = {t.normalized(): t for t in snap_tasks}

        # Append brand-new unchecked items the user added since the snapshot.
        for t in fresh_unchecked:
            if t.normalized() not in known_norms:
                snap_tasks.append(t)

        # Execution set = everything not marked done, stable file order.
        # Skipped tasks (e.g. a failed account switch from a previous run) are
        # reset to pending so the next run retries them instead of finishing
        # with an empty queue (previously: next_task() only saw pending/running
        # and the whole run exited immediately).
        for t in snap_tasks:
            if t.status == "skipped":
                t.status = "pending"
        # Drop snapshot tasks that no longer exist in the current TODO.md —
        # the project may have been switched (snapshot is global per state_dir),
        # and a stale task from another project must not leak into this queue.
        current_norms = fresh_done_norms | fresh_unchecked_norms
        queue = [t for t in snap_tasks if t.status != "done" and t.normalized() in current_norms]
        queue.sort(key=lambda t: t.index)
        st.queue = queue
        st.switches_used = int(snap.get("switches_used", 0))
        st.cooldown_until = float(snap.get("cooldown_until", 0.0))
        st.events_written = int(snap.get("events_written", 0))
        st.cdp_browser = snap.get("cdp_browser")
        st.started_at = float(snap.get("started_at", st.started_at))
        return st
