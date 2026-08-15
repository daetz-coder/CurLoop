"""TODO.md checkbox parsing -> ordered task queue, mark-done writer.

Parses markdown checkboxes (`- [ ]`, `- [x]`, `- [X]`, `- [-]`), supports CRLF,
indentation and bullets `-`/`*`/`+`. Generates the prompt fed to Cursor and
flips a finished item back to `[x]` by normalized text match (not frozen line
number), preserving original line endings.

`[-]` is treated as cancelled (done=True, not queued). Duplicate normalized
texts are skipped with a stderr warning.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .file_lock import FileLock

CHECKBOX_RE = re.compile(
    r"^(?P<indent>\s*)(?P<bullet>[-*+])\s+\[(?P<state>[ xX\-])\]\s+(?P<text>.+?)\s*$"
)

EnsureDoneResult = Literal["changed", "already", "missing"]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _todo_lock_path(todo_file: Path) -> Path:
    return todo_file.with_name(todo_file.name + ".lock")


@dataclass
class TodoTask:
    text: str
    line: int  # 1-based line number in TODO.md
    indent: str = ""
    bullet: str = "-"
    done: bool = False
    index: int = 0
    status: str = "pending"  # pending | running | done | skipped
    retries: int = 0
    switch_reason: str | None = None

    def normalized(self) -> str:
        return _norm(self.text)

    def prompt(self, project_dir: str) -> str:
        return (
            f"项目：{project_dir}\n"
            f"请完成 TODO：{self.text}\n"
            f"（接手现有工作继续做，直到任务真正完成；中途不要停。\n"
            f"完成后请 git add -A 并 git commit 提交你的改动，commit message 简要描述本任务。\n"
            f"完成本任务的过程中，如果实际进展表明还有值得继续的下一步（如新发现的问题、"
            f"拆出的子任务、下一步实现计划），请按 `- [ ] 任务描述` 格式追加到 TODO.md 末尾"
            f"（每行一项、只追加确有必要的，不要重复已有任务；没有就跳过这一条），"
            f"无人值守循环会读取 TODO.md 自动继续执行新任务。）"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "line": self.line,
            "indent": self.indent,
            "bullet": self.bullet,
            "done": self.done,
            "index": self.index,
            "status": self.status,
            "retries": self.retries,
            "switch_reason": self.switch_reason,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TodoTask":
        t = cls(
            text=str(d["text"]),
            line=int(d["line"]),
            indent=str(d.get("indent", "")),
            bullet=str(d.get("bullet", "-")),
            done=bool(d.get("done")),
            index=int(d.get("index", 0)),
        )
        t.status = str(d.get("status", "pending"))
        t.retries = int(d.get("retries", 0))
        t.switch_reason = d.get("switch_reason")
        return t


def parse_all(todo_file: Path) -> list[TodoTask]:
    """Parse every checkbox in TODO.md (checked and unchecked), file order.

    `[x]`/`[X]`/`[-]` → done (cancelled `[-]` is not queued). Duplicate
    normalized texts keep the first occurrence and warn on stderr.
    """
    if not todo_file.exists():
        return []
    text = todo_file.read_text(encoding="utf-8")
    # Normalize CRLF so offsets are predictable regardless of line endings.
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    tasks: list[TodoTask] = []
    seen: set[str] = set()
    for i, raw in enumerate(lines, start=1):
        m = CHECKBOX_RE.match(raw)
        if not m:
            continue
        task_text = m.group("text").strip()
        norm = _norm(task_text)
        if norm in seen:
            print(
                f"[warn] TODO 重复文案已跳过（保留首次）: {task_text[:60]}",
                file=sys.stderr,
            )
            continue
        seen.add(norm)
        state = m.group("state").lower()
        tasks.append(
            TodoTask(
                text=task_text,
                line=i,
                indent=m.group("indent"),
                bullet=m.group("bullet"),
                done=state in ("x", "-"),  # [-] = cancelled
                index=len(tasks),
            )
        )
    return tasks


def ensure_done(todo_file: Path, text: str) -> EnsureDoneResult:
    """Ensure the matching checkbox is `[x]`.

    Returns:
      - ``changed``: flipped an unchecked row to ``[x]``
      - ``already``: already ``[x]`` or cancelled ``[-]``
      - ``missing``: no matching row — appends ``- [x] text`` so snapshot/TODO
        stay aligned (avoids uncheck-requeue treating it as still open)
    """
    target = _norm(text)
    if not target:
        return "missing"
    clean = text.strip()
    todo_file.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(_todo_lock_path(todo_file)):
        if not todo_file.exists():
            todo_file.write_bytes(f"- [x] {clean}\n".encode("utf-8"))
            return "missing"
        raw = todo_file.read_bytes()
        crlf = b"\r\n" in raw
        sep = b"\r\n" if crlf else b"\n"
        body = raw.decode("utf-8")
        lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        for i, raw_line in enumerate(lines):
            m = CHECKBOX_RE.match(raw_line)
            if not m or _norm(m.group("text")) != target:
                continue
            state = m.group("state").lower()
            if state in ("x", "-"):
                return "already"
            lines[i] = f"{m.group('indent')}{m.group('bullet')} [x] {m.group('text')}"
            todo_file.write_bytes(("\r\n" if crlf else "\n").join(lines).encode("utf-8"))
            return "changed"
        # No match: append done checkbox.
        prefix = b"" if (not raw or raw.endswith(b"\n")) else sep
        todo_file.write_bytes(raw + prefix + f"- [x] {clean}".encode("utf-8") + sep)
        return "missing"


def mark_done(todo_file: Path, text: str) -> bool:
    """Flip unchecked checkbox to `[x]`. True if changed (not already/missing)."""
    return ensure_done(todo_file, text) == "changed"
