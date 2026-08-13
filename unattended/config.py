"""Runtime configuration for the unattended loop.

Loads `config.json` into typed dataclasses. Supports %APPDATA%/%USERPROFILE%
expansion. CLI overrides (project dir, mode) are applied by loop.py after load.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PKG_DIR = Path(__file__).resolve().parent
HARNESS_DIR = PKG_DIR.parent
DEFAULT_CONFIG = PKG_DIR / "config.json"

# Filled by loop.py before load when the user passes --project.
PROJECT_OVERRIDE: str | None = None


def _expand(s: str) -> str:
    if not s:
        return s
    s = s.replace("%APPDATA%", os.environ.get("APPDATA", ""))
    s = s.replace("%USERPROFILE%", str(Path.home()))
    return os.path.expandvars(s)


def _path(d: dict[str, Any], key: str, default: Any = None) -> Path | None:
    v = d.get(key, default)
    if v in (None, ""):
        return None
    return Path(_expand(str(v)))


def _num(d: dict[str, Any], key: str, default: float) -> float:
    v = d.get(key)
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


@dataclass
class CursorConfig:
    exe: Path
    profile: Path
    port: int = 9333
    remote_allow_origins: str = "*"

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CursorConfig":
        exe = _path(d, "exe") or Path(r"C:\Program Files\cursor\Cursor.exe")
        profile = _path(d, "profile") or (Path(os.environ.get("APPDATA", "")) / "Cursor")
        return cls(
            exe=exe,
            profile=profile,
            port=int(_num(d, "port", 9333)),
            remote_allow_origins=str(d.get("remote_allow_origins", "*")),
        )


@dataclass
class LoginAssistantConfig:
    exe: Path
    refresh_template: Path | None = None
    confirm_template: Path | None = None
    confidence: float = 0.85
    launch_wait_s: float = 8.0
    confirm_wait_s: float = 8.0
    close_after_refresh: bool = True

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "LoginAssistantConfig":
        return cls(
            exe=_path(d, "exe") or Path(),
            refresh_template=_path(d, "refresh_template"),
            confirm_template=_path(d, "confirm_template"),
            confidence=_num(d, "confidence", 0.85),
            launch_wait_s=_num(d, "launch_wait_s", 8.0),
            confirm_wait_s=_num(d, "confirm_wait_s", 8.0),
            close_after_refresh=bool(d.get("close_after_refresh", True)),
        )


@dataclass
class DetectionConfig:
    limit_require_recent: bool = True
    limit_keywords_en: list[str] = field(default_factory=list)
    limit_keywords_cn: list[str] = field(default_factory=list)
    logged_out_keywords: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DetectionConfig":
        return cls(
            limit_require_recent=bool(d.get("limit_require_recent", True)),
            limit_keywords_en=list(d.get("limit_keywords_en") or []),
            limit_keywords_cn=list(d.get("limit_keywords_cn") or []),
            logged_out_keywords=list(d.get("logged_out_keywords") or []),
        )


@dataclass
class Timeouts:
    cdp_ready_s: float = 90.0
    dom_ready_s: float = 120.0
    reply_max_s: float = 900.0
    completion_stable_polls: int = 4
    completion_poll_interval_s: float = 3.0
    min_elapsed_before_complete_s: float = 10.0
    switch_token_timeout_s: float = 60.0

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Timeouts":
        return cls(
            cdp_ready_s=_num(d, "cdp_ready_s", 90.0),
            dom_ready_s=_num(d, "dom_ready_s", 120.0),
            reply_max_s=_num(d, "reply_max_s", 900.0),
            completion_stable_polls=int(_num(d, "completion_stable_polls", 4)),
            completion_poll_interval_s=_num(d, "completion_poll_interval_s", 3.0),
            min_elapsed_before_complete_s=_num(d, "min_elapsed_before_complete_s", 10.0),
            switch_token_timeout_s=_num(d, "switch_token_timeout_s", 60.0),
        )


@dataclass
class RetryConfig:
    hang_retries_per_task: int = 1
    send_retries: int = 2
    max_total_account_switches_per_run: int = 5
    cooldown_between_switches_s: float = 30.0
    # auto-extend: when the TODO queue empties, ask the agent to plan new tasks
    # into TODO.md and keep going (bounded by auto_extend_max_iterations).
    auto_extend: bool = False
    auto_extend_max_iterations: int = 20

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "RetryConfig":
        return cls(
            hang_retries_per_task=int(_num(d, "hang_retries_per_task", 1)),
            send_retries=int(_num(d, "send_retries", 2)),
            max_total_account_switches_per_run=int(_num(d, "max_total_account_switches_per_run", 5)),
            cooldown_between_switches_s=_num(d, "cooldown_between_switches_s", 30.0),
            auto_extend=bool(d.get("auto_extend", False)),
            auto_extend_max_iterations=int(_num(d, "auto_extend_max_iterations", 20)),
        )


@dataclass
class Config:
    project_dir: Path
    todo_path: str = "TODO.md"
    final_goal_file: str = "FinalGoal.md"  # 目标驱动：项目根的最高目标文件
    auto_plan_todo: bool = True  # TODO.md 不存在时先读取 FinalGoal 生成初始规划
    git_commit_after_task: bool = True  # 每个任务完成后自动 git commit（提示词也会要求）
    cursor: CursorConfig = field(default_factory=CursorConfig)
    login_assistant: LoginAssistantConfig = field(default_factory=LoginAssistantConfig)
    detection: DetectionConfig = field(default_factory=DetectionConfig)
    timeouts: Timeouts = field(default_factory=Timeouts)
    retry: RetryConfig = field(default_factory=RetryConfig)
    state_dir: Path = field(default_factory=lambda: PKG_DIR / "runstate")
    event_log: str = "events.jsonl"
    mode: str = "dry-run"  # dry-run | live | limit-sim

    @property
    def todo_file(self) -> Path:
        return self.project_dir / self.todo_path

    @property
    def final_goal_file_path(self) -> Path:
        return self.project_dir / self.final_goal_file

    @property
    def project_state_dir(self) -> Path:
        """Per-project runstate dir: runstate/<slug>/ (isolates events/snapshot
        per project so stats never mix across projects)."""
        return self.state_dir / self._slug(self.project_dir.name)

    @property
    def snapshot_file(self) -> Path:
        return self.project_state_dir / "snapshot.json"

    @property
    def event_log_file(self) -> Path:
        return self.project_state_dir / "events.jsonl"

    @staticmethod
    def _slug(name: str) -> str:
        import re

        s = re.sub(r'[\\/:*?"<>|]', "_", name).replace(" ", "_")
        return s or "default"

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Config":
        project = Path(
            _expand(str(PROJECT_OVERRIDE or d.get("project_dir") or ""))
            or str(HARNESS_DIR)
        )
        state_dir = _path(d, "state_dir") or (PKG_DIR / "runstate")
        return cls(
            project_dir=project,
            todo_path=str(d.get("todo_path", "TODO.md")),
            final_goal_file=str(d.get("final_goal_file", "FinalGoal.md")),
            auto_plan_todo=bool(d.get("auto_plan_todo", True)),
            git_commit_after_task=bool(d.get("git_commit_after_task", True)),
            cursor=CursorConfig.from_dict(d.get("cursor") or {}),
            login_assistant=LoginAssistantConfig.from_dict(d.get("login_assistant") or {}),
            detection=DetectionConfig.from_dict(d.get("detection") or {}),
            timeouts=Timeouts.from_dict(d.get("timeouts") or {}),
            retry=RetryConfig.from_dict(d.get("retry") or {}),
            state_dir=state_dir,
            event_log=str(d.get("event_log", "events.jsonl")),
            mode=str(d.get("mode", "dry-run")),
        )

    @classmethod
    def load(cls, path: Path = DEFAULT_CONFIG) -> "Config":
        if path.exists():
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        else:
            data = {}
        return cls.from_dict(data)

    def validate(self) -> list[str]:
        """Return a list of problems (empty = OK). Does not touch processes/GUI."""
        problems: list[str] = []
        if not self.cursor.exe.exists():
            problems.append(f"cursor.exe 不存在: {self.cursor.exe}")
        if not self.cursor.profile.exists():
            problems.append(f"cursor profile 目录不存在: {self.cursor.profile}")
        if not self.login_assistant.exe.exists():
            problems.append(f"login_assistant.exe 不存在: {self.login_assistant.exe}")
        for name, p in (
            ("refresh_template", self.login_assistant.refresh_template),
            ("confirm_template", self.login_assistant.confirm_template),
        ):
            if p is not None and not p.exists():
                problems.append(f"login_assistant.{name} 不存在: {p}")
        if not self.project_dir.exists():
            problems.append(f"project_dir 不存在: {self.project_dir}")
        return problems
