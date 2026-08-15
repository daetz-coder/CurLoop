"""TODO.md checkbox parsing -> ordered task queue, mark-done writer.

Parses markdown checkboxes (`- [ ]`, `- [x]`, `- [X]`, `- [-]`), supports CRLF,
indentation and bullets `-`/`*`/`+`. Generates the prompt fed to Cursor and
flips a finished item back to `[x]` by normalized text match (not frozen line
number), preserving original line endings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CHECKBOX_RE = re.compile(
    r"^(?P<indent>\s*)(?P<bullet>[-*+])\s+\[(?P<state>[ xX\-])\]\s+(?P<text>.+?)\s*$"
)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


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
    """Parse every checkbox in TODO.md (checked and unchecked), file order."""
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
            continue
        seen.add(norm)
        tasks.append(
            TodoTask(
                text=task_text,
                line=i,
                indent=m.group("indent"),
                bullet=m.group("bullet"),
                done=m.group("state").lower() == "x",
                index=len(tasks),
            )
        )
    return tasks


def mark_done(todo_file: Path, text: str) -> bool:
    """Flip the first unchecked checkbox whose normalized text matches.

    Matches by whitespace-collapsed lowercase text (not frozen line number),
    so Agent inserts/deletes above the item do not mark the wrong row.
    Reads/writes bytes so CRLF and trailing-newline formatting are preserved
    (Path.read_text would apply universal-newline translation).
    """
    if not todo_file.exists():
        return False
    target = _norm(text)
    if not target:
        return False
    raw = todo_file.read_bytes()
    crlf = b"\r\n" in raw
    body = raw.decode("utf-8")
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for i, raw_line in enumerate(lines):
        m = CHECKBOX_RE.match(raw_line)
        if not m or m.group("state").lower() == "x":
            continue
        if _norm(m.group("text")) != target:
            continue
        lines[i] = f"{m.group('indent')}{m.group('bullet')} [x] {m.group('text')}"
        sep = "\r\n" if crlf else "\n"
        todo_file.write_bytes(sep.join(lines).encode("utf-8"))
        return True
    return False
