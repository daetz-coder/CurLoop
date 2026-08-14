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
# 仓库内默认配置（干净默认值，不含任何本机路径）
DEFAULT_CONFIG = PKG_DIR / "config.default.json"

# 用户配置（分发后外置，不入库）：%APPDATA%\cursor-harness\config.json
# 加载顺序：default → 用户配置 → --config 显式指定 → CLI 覆盖
_USER_APPDATA = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
USER_CONFIG_DIR = _USER_APPDATA / "cursor-harness"
USER_CONFIG = USER_CONFIG_DIR / "config.json"

# Filled by loop.py before load when the user passes --project.
PROJECT_OVERRIDE: str | None = None


def _expand(s: str) -> str:
    if not s:
        return s
    s = s.replace("%APPDATA%", os.environ.get("APPDATA", ""))
    s = s.replace("%USERPROFILE%", str(Path.home()))
    return os.path.expandvars(s)


# current_branch 缓存：.git/HEAD 内容基本不变，按 (path, mtime_ns) 命中，
# 避免周期状态块/status/watch 反复读文件。
_branch_cache: dict[str, tuple[int, str]] = {}


def current_branch(project_dir: Path) -> str:
    """当前 git 分支名（读 `.git/HEAD`，零子进程；runstate 按分支隔离的 key 来源）。

    - 普通仓库：`.git/HEAD` = ``ref: refs/heads/<branch>`` → 返回分支名
    - linked worktree：`.git` 是文件，内容 ``gitdir: <real .git>`` → 继续读其 HEAD
    - detached HEAD：HEAD 是 commit hash → 返回前 7 位（同 commit 稳定、不同 commit 隔离）
    - 非 git / 读取失败 → ``"default"``
    """
    candidates: list[Path] = []
    head = project_dir / ".git" / "HEAD"
    if head.exists():
        candidates.append(head)
    try:
        gitfile = project_dir / ".git"
        if gitfile.is_file():
            text = gitfile.read_text(encoding="utf-8", errors="replace").strip()
            if text.startswith("gitdir:"):
                candidates.append(Path(text[len("gitdir:"):].strip()) / "HEAD")
    except Exception:  # noqa: BLE001
        pass
    for h in candidates:
        try:
            mtime = h.stat().st_mtime_ns
            hit = _branch_cache.get(str(h))
            if hit is not None and hit[0] == mtime:
                return hit[1]
            text = h.read_text(encoding="utf-8", errors="replace").strip()
        except Exception:  # noqa: BLE001
            continue
        if text.startswith("ref: refs/heads/"):
            branch = text[len("ref: refs/heads/"):].strip()
        elif text and not text.startswith("ref:"):
            branch = text[:7]  # detached HEAD: 短 commit hash
        else:
            continue
        _branch_cache[str(h)] = (mtime, branch)
        return branch
    return "default"


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


def _detect_cursor_exe() -> str | None:
    """Cursor.exe 自动检测（配置未指定时）：常见安装路径逐个探测。"""
    pf = os.environ.get("PROGRAMFILES") or r"C:\Program Files"
    la = os.environ.get("LOCALAPPDATA") or ""
    candidates = [
        Path(pf) / "cursor" / "Cursor.exe",
        Path(la) / "Programs" / "cursor" / "Cursor.exe",
        Path(la) / "Anysphere" / "Cursor.exe",
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def _detect_assistant_exe() -> str | None:
    """换号助手 exe 自动检测：扫描桌面/下载目录里的 CursorLoginAssistant-*.exe。"""
    for d in (Path.home() / "Desktop", Path.home() / "Downloads"):
        try:
            hits = sorted(d.glob("CursorLoginAssistant-*.exe")) if d.exists() else []
        except OSError:
            hits = []
        if hits:
            return str(hits[-1])
    return None


@dataclass
class CursorConfig:
    exe: Path
    profile: Path
    port: int = 9333
    remote_allow_origins: str = "*"

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CursorConfig":
        exe = _path(d, "exe")
        if exe is None:  # 未配置 → 自动检测（常见安装路径）→ 兜底 Program Files
            exe = Path(_detect_cursor_exe() or r"C:\Program Files\cursor\Cursor.exe")
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
        exe = _path(d, "exe")
        if exe is None:  # 未配置 → 自动检测（桌面/下载目录扫描）
            exe = Path(_detect_assistant_exe() or "")
        return cls(
            exe=exe,
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
    reply_max_s: float = 0.0  # 等待回复硬超时；0 = 不限制（busy 期间本就不计，非 busy 卡死时无限等）
    completion_stable_polls: int = 4
    completion_poll_interval_s: float = 3.0
    min_elapsed_before_complete_s: float = 10.0
    switch_token_timeout_s: float = 60.0

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Timeouts":
        return cls(
            cdp_ready_s=_num(d, "cdp_ready_s", 90.0),
            dom_ready_s=_num(d, "dom_ready_s", 120.0),
            reply_max_s=_num(d, "reply_max_s", 0.0),
            completion_stable_polls=int(_num(d, "completion_stable_polls", 4)),
            completion_poll_interval_s=_num(d, "completion_poll_interval_s", 3.0),
            min_elapsed_before_complete_s=_num(d, "min_elapsed_before_complete_s", 10.0),
            switch_token_timeout_s=_num(d, "switch_token_timeout_s", 60.0),
        )


@dataclass
class RetryConfig:
    hang_retries_per_task: int = 1
    send_retries: int = 2
    max_total_account_switches_per_run: int = 0  # 0 = 不限换号次数（每 run 独立预算）
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
            max_total_account_switches_per_run=int(_num(d, "max_total_account_switches_per_run", 0)),
            cooldown_between_switches_s=_num(d, "cooldown_between_switches_s", 30.0),
            auto_extend=bool(d.get("auto_extend", False)),
            auto_extend_max_iterations=int(_num(d, "auto_extend_max_iterations", 20)),
        )


@dataclass
class UiConfig:
    """终端可视化配置（CLI 模式；非全屏状态块，不遮挡换号助手窗口）。"""

    periodic_status_s: float = 180.0  # loop 运行中每 N 秒打印一次状态块；0 = 关闭（默认 3 分钟）

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "UiConfig":
        return cls(periodic_status_s=_num(d, "periodic_status_s", 180.0))


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
    ui: UiConfig = field(default_factory=UiConfig)
    state_dir: Path = field(default_factory=lambda: USER_CONFIG_DIR / "runstate")
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
        """Per-(project, git branch) runstate dir: runstate/<slug>@<branch>/.

        Isolates snapshot/events per branch so switching branches never mixes
        queues, switch budgets, stats or event timelines. Non-git projects use
        the `default` branch key (keeps the legacy directory name).
        """
        key = f"{self.project_dir.name}@{current_branch(self.project_dir)}"
        return self.state_dir / self._slug(key)

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
            or str(Path.cwd())  # 未指定项目 → 当前目录（与 curloop 的 cwd 语义一致）
        )
        state_dir = _path(d, "state_dir") or (USER_CONFIG_DIR / "runstate")
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
            ui=UiConfig.from_dict(d.get("ui") or {}),
            state_dir=state_dir,
            event_log=str(d.get("event_log", "events.jsonl")),
            mode=str(d.get("mode", "dry-run")),
        )

    @classmethod
    def load(cls, path: Path = DEFAULT_CONFIG) -> "Config":
        """合并加载配置：仓库默认 config.default.json → %APPDATA% 用户配置 → --config 显式指定。

        - 默认配置不含任何本机路径（Cursor/换号助手路径由自动检测补齐）；
        - 用户配置覆盖默认（分发后写 %APPDATA%\\cursor-harness\\config.json）；
        - `--config FILE`（与默认不同时）优先级最高；
        - CLI 覆盖（--project / --mode）在 loop.py 里 load 之后应用。
        """
        data: dict[str, Any] = {}
        sources: list[Path] = [DEFAULT_CONFIG, USER_CONFIG]
        if path is not None and path.resolve() != DEFAULT_CONFIG.resolve():
            sources.append(path)
        for src in sources:
            if src is None or not src.exists():
                continue
            try:
                with src.open("r", encoding="utf-8") as fh:
                    data.update(json.load(fh))
            except Exception as exc:  # noqa: BLE001  （用户配置损坏不应致命）
                print(f"[config] 警告：读取 {src} 失败：{exc}，已跳过")
        return cls.from_dict(data)

    def validate(self) -> list[str]:
        """Return a list of problems (empty = OK). Does not touch processes/GUI."""
        problems: list[str] = []
        if not self.cursor.exe or not self.cursor.exe.exists():
            problems.append(f"cursor.exe 不存在: {self.cursor.exe}")
        if not self.cursor.profile.exists():
            problems.append(f"cursor profile 目录不存在: {self.cursor.profile}")
        if not self.login_assistant.exe or not self.login_assistant.exe.exists():
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
