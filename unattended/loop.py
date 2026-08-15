"""Unattended Cursor coding loop — state machine + CLI.

Run from the harness dir:
    python -m unattended.loop --check-config
    python -m unattended.loop --dry-run
    python -m unattended.loop --mode live --project D:\\2026AppDev\\RAGLab
    python -m unattended.loop --mode limit-sim
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import config as config_mod
from . import cursor_ctl
from . import observer
from . import ui
from .config import Config
from .detection import CompletionTracker, REPLY_JS, build_limit_js, build_logout_js
from .login_assistant import refresh_account
from .run_state import RunState
from .todo_queue import TodoTask, mark_done, parse_all


# ------------------------------------------------------------------- CLIs ----
def cmd_check_config(cfg: Config) -> int:
    problems = cfg.validate()
    for p in problems:
        print("[!]", p)
    if problems:
        print("[fail] 配置有问题")
        return 1
    print("[ok] config paths OK")
    print("  project_dir :", cfg.project_dir, "(exists:", cfg.project_dir.exists(), ")")
    print("  todo_file   :", cfg.todo_file, "(exists:", cfg.todo_file.exists(), ")")
    print("  cursor.exe  :", cfg.cursor.exe)
    print("  cursor.prof :", cfg.cursor.profile)
    print("  assistant   :", cfg.login_assistant.exe)
    auth = cursor_ctl.auth_info(cfg)
    print("  auth        :", {k: auth.get(k) for k in ("db_exists", "has_access_token", "email", "access_fp")})
    return 0


def cmd_dry_run(cfg: Config) -> int:
    tasks = parse_all(cfg.todo_file)
    pending = [t for t in tasks if not t.done]
    print(f"TODO.md: {len(tasks)} 项，待办 {len(pending)} 项")
    for t in pending:
        print(f"  [{t.index}] (L{t.line}) {t.text}")
    print("cdp up      :", cursor_ctl.cdp_up(cfg.cursor.port))
    print("cdp version :", cursor_ctl.cdp_version(cfg.cursor.port))
    print("auth fp     :", cursor_ctl.auth_fp(cfg))
    print("templates   : refresh=", cfg.login_assistant.refresh_template.exists(),
          " confirm=", cfg.login_assistant.confirm_template.exists(), sep="")
    return 0


def cmd_assistant_dry_run(cfg: Config) -> int:
    print("[assistant-dry-run] 只定位，不点击、不启动新进程（除非已在运行）")
    rep = refresh_account(cfg, dry_run=True)
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    window_ok = any(s.get("step") == "window" and s.get("ok") for s in rep["steps"])
    refresh_ok = any(s.get("step") == "refresh" and s.get("ok") for s in rep["steps"])
    print("[assistant-dry-run] window_ok=", window_ok, " refresh_template_found=", refresh_ok)
    return 0 if window_ok else 1


def cmd_detect_only(cfg: Config, seconds: float) -> int:
    cursor_ctl.init(cfg)
    if not cursor_ctl.cdp_up(cfg.cursor.port):
        print("CDP 未就绪（Cursor 未带调试端口运行），先启动再 --detect-only")
        return 1
    tracker = CompletionTracker(
        stable_polls=cfg.timeouts.completion_stable_polls,
        min_elapsed=cfg.timeouts.min_elapsed_before_complete_s,
        hard_timeout=cfg.timeouts.reply_max_s,
    )
    prev: set[str] = set()
    deadline = time.time() + seconds
    while time.time() < deadline:
        r = cursor_ctl.poll_reply(cfg, tracker, prev)
        prev = set(r.get("limit_sample", {}).get("hits") or [])
        print(
            f"state={r['state']} detail={r.get('detail')!r} "
            f"hits={sorted(prev)} hard={r.get('limit_sample', {}).get('hard')} "
            f"loggedOut={r.get('logout', {}).get('loggedOut')} "
            f"busy={r.get('reply', {}).get('busy')} pairCount={r.get('reply', {}).get('pairCount')}"
        )
        time.sleep(cfg.timeouts.completion_poll_interval_s)
    return 0


def cmd_assistant_refresh_only(cfg: Config) -> int:
    """Verification: kill Cursor, click 刷新Cursor, confirm, wait for token flip."""
    cursor_ctl.init(cfg)
    old = cursor_ctl.auth_fp(cfg)
    print("[refresh-only] 旧 token fp:", old)
    cursor_ctl.kill_all_cursor()
    rep = refresh_account(cfg, dry_run=False)
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    ok, info = cursor_ctl.wait_token_change(cfg, old, cfg.timeouts.switch_token_timeout_s)
    print("[refresh-only] token 变化:", ok, "->", info.get("access_fp"), info.get("email"))
    return 0 if ok else 1


def cmd_inject_limit_node(cfg: Config) -> int:
    cursor_ctl.init(cfg)
    if not cursor_ctl.cdp_up(cfg.cursor.port):
        print("CDP 未就绪")
        return 1
    print(cursor_ctl.inject_limit_node(cfg.cursor.port))
    return 0


# ------------------------------------------------------------------ helpers ----
def _can_switch(cfg: Config, state: RunState) -> bool:
    m = cfg.retry.max_total_account_switches_per_run
    return m <= 0 or state.switches_used < m  # <=0 = 不限次数（默认）


def _skip(state: RunState, task: TodoTask, reason: str) -> str:
    task.status = "skipped"
    task.switch_reason = reason
    state.log("task_skipped", task=task.text[:60], reason=reason)
    return "skipped"


def _do_switch(cfg: Config, state: RunState, task: TodoTask) -> bool:
    old = cursor_ctl.auth_fp(cfg)
    state.log("switch_start", task=task.text[:40], old_fp=old)
    cursor_ctl.kill_all_cursor()
    rep = refresh_account(cfg, dry_run=False)
    state.log("switch_click", report=json.dumps(rep, ensure_ascii=False, default=str))
    ok, info = cursor_ctl.wait_token_change(cfg, old, cfg.timeouts.switch_token_timeout_s)
    state.switches_used += 1
    state.save()
    if not ok:
        state.log("switch_failed", reason="token 未变化")
        return False
    state.log("switch_ok", new_fp=info.get("access_fp"), email=info.get("email"))
    cd = cfg.retry.cooldown_between_switches_s
    if cd:
        state.log("cooldown", seconds=cd)
        time.sleep(cd)
    return True


def _ensure_ready(cfg: Config, state: RunState, task: TodoTask) -> str:
    """Ensure a logged-in Cursor with CDP. Returns 'ok' | 'switch' | 'failed'."""
    if not cursor_ctl.auth_fp(cfg):
        state.log("no_auth", task=task.text[:40])
        return "switch"
    res = cursor_ctl.ensure_ready(cfg, cfg.project_dir, relaunch=True)
    if res.get("ok"):
        return "ok"
    state.log("ensure_failed", errors=res.get("errors"))
    return "failed"


# 周期状态块计时（单线程 loop，模块级足够）：距上次 >= periodic 时打印。
_last_status_ts = 0.0


def _maybe_print_status(cfg: Config) -> None:
    """周期状态块：距上次打印 >= cfg.ui.periodic_status_s 秒时输出一次（0 关闭）。

    在 run() 主循环与各长轮询循环（_wait_reply / _ensure_idle_before_send）里
    调用，保证任务执行期间（Agent 长任务可阻塞 run_task 十几分钟）状态也刷新，
    而不是只在任务间隙打印。
    """
    global _last_status_ts
    periodic = cfg.ui.periodic_status_s
    if periodic <= 0:
        return
    now = time.monotonic()
    if now - _last_status_ts < periodic:
        return
    _last_status_ts = now
    try:
        print(ui.status_render(observer.build_status(
            project=str(cfg.project_dir), state_dir=cfg.state_dir,
        )))
        print()
    except Exception:  # noqa: BLE001  状态面板异常不影响主循环
        pass


def _ensure_idle_before_send(cfg: Config, state: RunState | None = None, timeout_s: float = 1800.0) -> str:
    """Wait (up to timeout) until Cursor reports idle before sending the next
    prompt. Second line of defence against queueing prompts while the agent is
    still executing a long tool (shell/read/planning): even if wait_reply
    misjudges 'done', this gate blocks the actual send until busy clears.
    On CDP error or timeout we proceed anyway to avoid deadlock.

    Returns "ok"（busy 已清，可发送）| "limit" | "logged_out"（等待期间
    页面出现 usage limit / 登出提示——不能干等，调用方应触发换号）。
    """
    deadline = time.time() + timeout_s
    waited = 0.0
    while time.time() < deadline:
        _maybe_print_status(cfg)  # 长等待期间也刷新周期状态块
        try:
            s = cursor_ctl.evaluate_js(cfg.cursor.port, REPLY_JS) or {}
            if not s.get("busy"):
                return "ok"
            flags = sorted(
                k for k in ("hasStop", "thinking", "toolActivity", "toolRunning",
                            "toolWaiting", "hasQueued", "composerText") if s.get(k)
            )
        except Exception:  # noqa: BLE001  CDP trouble — don't block the run
            return "ok"
        # 空闲门禁期间每 30s：记事件（用户能看到卡在哪）+ 清弹窗 + 检测
        # limit/logged_out。REPLY_JS 只报 busy 不报 limit——busy 恒真而页面
        # 出现 "you've hit your usage limit" 时必须换号，不能干等 1800s。
        if waited >= 30.0:
            waited = 0.0
            try:
                ls = cursor_ctl.evaluate_js(cfg.cursor.port, build_limit_js(cfg.detection)) or {}
                hits = ls.get("hits") or []
                # idle 门禁内放宽为 hits 非空：busy 等待 + 页面出现 limit 关键词
                # 几乎必是真 limit（Agent 因限流卡住），不是常驻横幅（横幅通常
                # 伴随非 busy）。严格 >=2/hard 规则会漏掉单关键词页面
                # （如 "you've hit your usage limit" 只命中 usage limit）。
                if hits:
                    if state is not None:
                        state.log("idle_limit", hits=hits, busy=True, flags=flags)
                    return "limit"
                lo = cursor_ctl.evaluate_js(cfg.cursor.port, build_logout_js(cfg.detection)) or {}
                if lo.get("loggedOut"):
                    return "logged_out"
            except Exception:  # noqa: BLE001
                pass
            if state is not None:
                state.log("idle_wait", busy=True, flags=flags,
                          detail="awaiting idle before send")
            # Agent 空闲但 composer 残留文本（唯一 busy 信号）→ 清空解除卡死：
            # 这是上一条 prompt 发送后的回显/残留，等 idle 永远不会来。
            if flags == ["composerText"]:
                cleared = cursor_ctl.clear_composer(cfg)
                if state is not None and cleared.get("ok"):
                    state.log("composer_cleared",
                              reason="leftover composer text, agent idle")
            try:
                cursor_ctl.dismiss_all(cfg.cursor.port)
            except Exception:  # noqa: BLE001
                pass
        time.sleep(5)
        waited += 5.0
    return "ok"  # 超时：按原语义放行，避免死锁


def _send(cfg: Config, state: RunState, task: TodoTask, prompt: str) -> bool:
    if task.retries:
        prompt = f"{prompt}\n[这是第 {task.retries + 1} 次尝试，请继续完成；之前可能被中断]"
    for attempt in range(cfg.retry.send_retries + 1):
        if _ensure_idle_before_send(cfg, state) != "ok":  # limit/logged_out → 让 run_task 换号
            return False
        sr = cursor_ctl.send_prompt(cfg, prompt)
        if sr.get("ok"):
            state.log("sent", task=task.text[:40], attempt=attempt)
            return True
        reason = (sr.get("type") or {}).get("reason") or sr.get("error") or "unknown"
        state.log("send_failed", attempt=attempt, reason=reason)
        time.sleep(2)
    return False


EXTEND_PROMPT = (
    "项目：{project}\n"
    "请分析当前项目的状态（git 状态、最近改动、TODO.md 中已完成与未完成项、未解决事项），\n"
    "然后在 TODO.md 文件末尾追加 1 到 3 个新的、具体可执行的 `- [ ]` 任务，持续推进项目。\n"
    "如果确实没有值得做的新任务，就不要追加，直接回复：无新任务。"
)

GOAL_EXTEND_PROMPT = (
    "项目：{project}\n"
    "轻量规划已确认没有新的增量任务。以下是本项目的最终目标（FinalGoal）：\n"
    "--- FinalGoal 开始 ---\n{goal}\n--- FinalGoal 结束 ---\n"
    "请对照 FinalGoal 逐项检查硬门槛与交付物：\n"
    "1) 若全部已达成（目标完成）→ 不要追加任何任务，直接回复：目标完成\n"
    "2) 若仍有未达成的目标 → 在 TODO.md 末尾追加 1~3 个最优先的 `- [ ]` 任务来推进，并简要回复追加情况\n"
    "不要重复已有 TODO 中的任务。"
)

INITIAL_PLAN_PROMPT = (
    "项目：{project}\n"
    "以下是本项目的最终目标（FinalGoal）：\n"
    "--- FinalGoal 开始 ---\n{goal}\n--- FinalGoal 结束 ---\n"
    "请在项目根目录创建 TODO.md：\n"
    "- 用 `- [ ] ` 列出当前最优先的 3~5 个具体可执行任务（涉及具体文件/路径，按优先级排序）\n"
    "- 任务要具体到可直接执行，不要一次列太多（后续会继续规划补充）\n"
    "- 直接写入 TODO.md 文件，然后回复：已完成规划"
)

_GOAL_CHUNK = 6000  # FinalGoal 可能很长；规划时只带前段（验收标准/硬门槛通常在前）


def _read_final_goal(cfg: Config) -> str:
    try:
        return cfg.final_goal_file_path.read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return ""


def _send_and_wait(cfg: Config, state: RunState, prompt: str, event_prefix: str = "extend") -> str:
    """ensure_ready -> send -> wait for the agent to finish.

    Returns "ok"（回复完成）| "switch"（撞 limit/logged_out，可换号恢复）
    | "failed"（其他不可恢复失败）。与任务路径 _wait_reply 的语义对齐。
    """
    state.log(f"{event_prefix}_start", project=str(cfg.project_dir))
    er = cursor_ctl.ensure_ready(cfg, cfg.project_dir, relaunch=True)
    if not er.get("ok"):
        state.log(f"{event_prefix}_failed", reason=str(er.get("errors") or "not ready"))
        return "failed"
    gate = _ensure_idle_before_send(cfg, state)  # don't queue the plan prompt while the agent is busy
    if gate in ("limit", "logged_out"):
        state.log(f"{event_prefix}_failed", reason=gate)
        return "switch"  # 可恢复：_extend_or_switch 会换号后重试
    sr = cursor_ctl.send_prompt(cfg, prompt, submit=True)
    if not sr.get("ok"):
        reason = sr.get("error") or (sr.get("type") or {}).get("reason") or "send failed"
        state.log(f"{event_prefix}_failed", reason=reason)
        return "failed"
    state.log(f"{event_prefix}_sent")
    tracker = CompletionTracker(
        stable_polls=cfg.timeouts.completion_stable_polls,
        min_elapsed=cfg.timeouts.min_elapsed_before_complete_s,
        hard_timeout=cfg.timeouts.reply_max_s,
    )
    prev: set[str] = set()
    interval = cfg.timeouts.completion_poll_interval_s
    while True:
        time.sleep(interval)
        _maybe_print_status(cfg)  # 扩展/规划等待期间也刷新周期状态块
        r = cursor_ctl.poll_reply(cfg, tracker, prev)
        st = r["state"]
        if st == "done":
            return "ok"
        if st in ("limit", "logged_out"):
            state.log(f"{event_prefix}_failed", reason=st)
            return "switch"  # 可恢复：调用方换号后重试
        if st in ("no_page", "cdp_error", "hard_timeout"):
            state.log(f"{event_prefix}_failed", reason=st)
            return "failed"
        # busy / waiting：Agent 正在生成扩展/规划回复，继续等（CompletionTracker
        # 负责最终判定；卡死由 hard_timeout 兜底，不会无限等）。此前把 busy
        # 误判为失败导致扩展在 Agent 回复中途就放弃（extend_failed busy）。


def _extend_or_switch(cfg: Config, state: RunState, prompt: str, event_prefix: str) -> bool:
    """扩展/规划等待：撞 limit/logged_out 时换号后重试，而不是当作"无新任务"放弃。

    之前 _send_and_wait 对 limit 只记 extend_failed 返回 False，队列空 + 撞 limit
    时主循环会直接 run_done 退出（"Get Cursor Pro" 提示后不换号就是死因）。此处
    与任务路径一致：limit/logged_out 视为可恢复，受 _can_switch 预算约束换号重试。
    返回 True = 本次发送最终完成（队列是否新增由调用方 _reload_queue 决定）。
    """
    for attempt in range(cfg.retry.send_retries + 1):
        r = _send_and_wait(cfg, state, prompt, event_prefix)
        if r == "ok":
            return True
        if r != "switch":
            return False
        if not _can_switch(cfg, state):
            state.log(f"{event_prefix}_failed", reason="switch budget exhausted")
            return False
        # 扩展/规划路径没有真实任务，用占位 TodoTask 记录本次换号用途
        dummy = TodoTask(text=f"{event_prefix} (queue empty)", line=0)
        if not _do_switch(cfg, state, dummy):
            state.log(f"{event_prefix}_failed", reason="switch_failed")
            return False
        state.log(f"{event_prefix}_switch_retry", attempt=attempt + 1)
    state.log(f"{event_prefix}_failed", reason="send retries exhausted")
    return False


def _reload_queue(cfg: Config, state: RunState, event_prefix: str) -> RunState | None:
    """Reload the queue from TODO.md; return the fresh state if new tasks appeared."""
    fresh = RunState.load(cfg.snapshot_file, cfg.event_log_file, cfg.todo_file)
    new_tasks = sum(1 for t in fresh.queue if t.status in ("pending", "running"))
    state.log(f"{event_prefix}_result", new_tasks=new_tasks)
    return fresh if new_tasks > 0 else None


def _try_extend_tasks(cfg: Config, state: RunState) -> RunState | None:
    """Level-1 light auto-extend: plan from the current TODO/project state only."""
    if not _extend_or_switch(cfg, state, EXTEND_PROMPT.format(project=cfg.project_dir), "extend"):
        return None
    return _reload_queue(cfg, state, "extend")


def _try_goal_extend(cfg: Config, state: RunState) -> RunState | None:
    """Level-2: light extend found nothing -> re-read FinalGoal and re-plan.

    Only called after level-1 confirms no incremental tasks, so the (large)
    FinalGoal is not re-read on every queue drain.
    """
    goal = _read_final_goal(cfg)
    if not goal:
        state.log("goal_extend_failed", reason="FinalGoal not found")
        return None
    if not _extend_or_switch(cfg, state, GOAL_EXTEND_PROMPT.format(project=cfg.project_dir, goal=goal[:_GOAL_CHUNK]), "goal_extend"):
        return None
    return _reload_queue(cfg, state, "goal_extend")


def _plan_initial_todo(cfg: Config, state: RunState) -> RunState | None:
    """TODO.md missing: read FinalGoal and ask the agent to create the initial plan.

    Returns the fresh RunState when tasks appeared, None otherwise.
    """
    goal = _read_final_goal(cfg)
    if not goal:
        state.log("plan_todo_failed", reason="FinalGoal not found")
        return None
    if not _extend_or_switch(cfg, state, INITIAL_PLAN_PROMPT.format(project=cfg.project_dir, goal=goal[:_GOAL_CHUNK]), "plan_todo"):
        return None
    return _reload_queue(cfg, state, "plan_todo")


def _git_commit(cfg: Config, task: TodoTask) -> None:
    """Best-effort commit after a finished task (the prompt also asks the agent)."""
    if not cfg.git_commit_after_task:
        return
    try:
        msg = f"task: {task.text[:60]}"
        subprocess.run(["git", "add", "-A"], cwd=str(cfg.project_dir), capture_output=True)
        subprocess.run(["git", "commit", "-m", msg], cwd=str(cfg.project_dir), capture_output=True)
    except Exception:  # noqa: BLE001  (not a git repo, no changes, etc.)
        pass


def _is_prompt_echo(prompt_norm: str, last_full: str) -> bool:
    """True when the 'last message' is actually the prompt we sent (composer echo),
    not an assistant reply. Guards against false 'done' before the model answers."""
    if not prompt_norm or not last_full:
        return False
    n = re.sub(r"\s+", " ", last_full).strip().lower()
    p = prompt_norm.lower()
    if not n:
        return False
    if n == p:
        return True
    # Truncated echo: last message is a long prefix of the prompt.
    if len(n) >= 20 and len(p) >= 20 and p.startswith(n) and len(n) >= len(p) * 0.6:
        return True
    return False


def _wait_reply(cfg: Config, state: RunState, task: TodoTask, sim: dict[str, bool], prompt: str) -> tuple[str, str]:
    """Poll until done / relaunch / switch. Returns (outcome, detail)."""
    tracker = CompletionTracker(
        stable_polls=cfg.timeouts.completion_stable_polls,
        min_elapsed=cfg.timeouts.min_elapsed_before_complete_s,
        hard_timeout=cfg.timeouts.reply_max_s,
    )
    prompt_norm = re.sub(r"\s+", " ", prompt).strip()
    prev: set[str] = set()
    interval = cfg.timeouts.completion_poll_interval_s
    state.log("wait_reply", task=task.text[:60])
    poll_count = 0
    last_poll_key: tuple | None = None  # 仅状态变化时落盘 poll，避免长跑刷爆 jsonl

    def _log_poll_if_changed(st: str, detail: str, r: dict) -> None:
        nonlocal last_poll_key
        key = (
            st,
            bool(r.get("limit_sample", {}).get("hard")),
            bool(r.get("logout", {}).get("loggedOut")),
            bool(r.get("reply", {}).get("busy")),
            r.get("reply", {}).get("pairCount"),
            detail[:80] if detail else "",
        )
        if key == last_poll_key:
            return
        last_poll_key = key
        state.log(
            "poll", state=st, detail=detail, hits=sorted(prev),
            hard=r.get("limit_sample", {}).get("hard"),
            loggedOut=r.get("logout", {}).get("loggedOut"),
            busy=r.get("reply", {}).get("busy"),
            pairCount=r.get("reply", {}).get("pairCount"),
        )

    while True:
        time.sleep(interval)
        poll_count += 1
        _maybe_print_status(cfg)  # 长等待（等回复）期间也刷新周期状态块
        # Promo/update modals can pop up mid-conversation; dismiss periodically
        # so they don't cover the composer or stall the next send.
        if poll_count % 3 == 0:
            try:
                cursor_ctl.dismiss_all(cfg.cursor.port)
            except Exception:  # noqa: BLE001
                pass
        r = cursor_ctl.poll_reply(cfg, tracker, prev)
        prev = set(r.get("limit_sample", {}).get("hits") or [])
        st, detail = r["state"], r.get("detail", "")
        if cfg.mode == "limit-sim" and not sim.get("forced") and st in ("waiting", "busy"):
            st, detail = "limit", "limit-sim forced (once)"
            sim["forced"] = True
        _log_poll_if_changed(st, detail, r)
        if st == "done":
            if _is_prompt_echo(prompt_norm, (r.get("reply") or {}).get("lastFull") or ""):
                tracker.disqualify()
                _log_poll_if_changed("waiting", "prompt echo, still waiting", r)
                continue
            # Confirm silence: one more poll to make sure the agent is really
            # idle (no busy flag, no new message pair, no tool-card change)
            # before declaring done — otherwise the next prompt queues up
            # while the agent is still executing a long tool.
            time.sleep(interval)
            r2 = cursor_ctl.poll_reply(cfg, tracker, prev)
            if r2["state"] == "done":
                return "done", detail
            _log_poll_if_changed(r2["state"], r2.get("detail", ""), r2)
            continue
        if st in ("limit", "logged_out"):
            return "switch", detail
        if st in ("no_page", "cdp_error"):
            if task.retries < cfg.retry.hang_retries_per_task:
                return "relaunch", detail
            return "switch", detail
        if st == "hard_timeout":
            if task.retries < cfg.retry.hang_retries_per_task:
                return "relaunch", detail
            return "switch", detail


# -------------------------------------------------------------------- task ----
def run_task(cfg: Config, state: RunState, task: TodoTask, sim: dict[str, bool]) -> str:
    prompt = task.prompt(str(cfg.project_dir))
    state.log("task_start", task=task.text[:60], line=task.line, retries=task.retries)
    while True:
        ready = _ensure_ready(cfg, state, task)
        if ready in ("switch", "failed"):
            if not _can_switch(cfg, state):
                return _skip(state, task, f"ensure:{ready}")
            task.retries += 1
            if not _do_switch(cfg, state, task):
                return _skip(state, task, "switch_failed")
            continue

        if not _send(cfg, state, task, prompt):
            if not _can_switch(cfg, state):
                return _skip(state, task, "send_failed")
            task.retries += 1
            if not _do_switch(cfg, state, task):
                return _skip(state, task, "switch_failed")
            continue

        outcome, detail = _wait_reply(cfg, state, task, sim, prompt)
        if outcome == "done":
            if not mark_done(cfg.todo_file, task.text):
                print(f"[warn] mark_done 未匹配到 TODO 行: {task.text[:60]}")
            task.status = "done"
            task.done = True
            state.log("task_done", task=task.text[:60], detail=detail)
            return "done"
        if outcome == "relaunch":
            task.retries += 1
            state.log("relaunch_retry", task=task.text[:60], detail=detail)
            cursor_ctl.kill_all_cursor()
            continue
        # limit / logged_out / hard_timeout / switch
        if not _can_switch(cfg, state):
            return _skip(state, task, f"{outcome}:{detail} (no switch budget)")
        task.retries += 1
        state.log("switch_trigger", task=task.text[:60], reason=outcome, detail=detail)
        if not _do_switch(cfg, state, task):
            return _skip(state, task, "switch_failed")


# -------------------------------------------------------------------- main ----
def run(cfg: Config) -> int:
    cursor_ctl.init(cfg)
    state = RunState.load(cfg.snapshot_file, cfg.event_log_file, cfg.todo_file)
    state.log(
        "run_start", mode=cfg.mode, project=str(cfg.project_dir),
        profile=str(cfg.cursor.profile), todo=str(cfg.todo_file),
    )
    sim: dict[str, bool] = {"forced": False}  # limit-sim: force the switch once
    extend_used = 0  # level-1 light auto-extend refills
    goal_extend_used = 0  # level-2 FinalGoal re-plans
    state.switches_used = 0  # 每次 run 独立换号预算（不跨 run 累计）
    ui.init()
    try:
        while True:
            _maybe_print_status(cfg)  # 周期状态块（_wait_reply/_ensure_idle 内也会调用）
            task = state.next_task()
            if task is None:
                # Queue empty. TODO.md missing (first run / deleted) -> always
                # re-read FinalGoal and regenerate the plan, never light-extend.
                fresh = None
                if not cfg.todo_file.exists() and cfg.auto_plan_todo:
                    fresh = _plan_initial_todo(cfg, state)
                # Level 1: light auto-extend from current TODO state.
                if fresh is None and cfg.retry.auto_extend and extend_used < cfg.retry.auto_extend_max_iterations:
                    fresh = _try_extend_tasks(cfg, state)
                    if fresh is not None:
                        extend_used += 1
                # Level 2: only if light planning really found nothing, re-read
                # the (large) FinalGoal and re-plan against it.
                if fresh is None and cfg.retry.auto_extend and goal_extend_used < cfg.retry.auto_extend_max_iterations:
                    fresh = _try_goal_extend(cfg, state)
                    if fresh is not None:
                        goal_extend_used += 1
                if fresh is not None:
                    # Adopt the freshly planned queue — our own state is still empty.
                    state = fresh
                    state.save()
                    continue
                # Otherwise leave the UI usable — best-effort dismiss any
                # modal (e.g. "Update recommended") even though no task will run.
                try:
                    if cursor_ctl.cdp_up(cfg.cursor.port):
                        cursor_ctl.dismiss_until_clear(cfg.cursor.port, timeout_s=15.0, poll=2.0)
                except Exception:  # noqa: BLE001
                    pass
                state.log("run_done", pending=0)
                print(json.dumps({"run_done": True, "queue": len(state.queue), "switches": state.switches_used}, ensure_ascii=False))
                return 0
            task.status = "running"
            state.save()
            try:
                outcome = run_task(cfg, state, task, sim)
            except Exception as e:  # noqa: BLE001  -- never let one flaky task kill the run
                state.log("task_error", task=task.text[:60], error=str(e))
                _skip(state, task, f"exception: {e}")
                outcome = "skipped"
            if outcome == "done":
                _git_commit(cfg, task)
                # 任务完成后重新加载 TODO.md：吸收 Agent 按提示词追加的新任务
                # （执行中生成的计划/子任务），让队列随实际进展动态更新，而
                # 不是等队列空了才走扩展。没有新任务则沿用当前 state。
                fresh = _reload_queue(cfg, state, "task_done")
                if fresh is not None:
                    # load() 从 snapshot 恢复预算/冷却；同步当前内存值再保存，
                    # 避免覆盖本次 run 已累计的换号预算。
                    fresh.switches_used = state.switches_used
                    fresh.cooldown_until = state.cooldown_until
                    state = fresh
                    state.save()
            if outcome == "abort":
                state.log("run_abort")
                state.save()
                return 2  # distinct from crash(1): watchdog must NOT restart on abort
            state.save()
    except KeyboardInterrupt:
        state.log("interrupt")
        state.save()
        print("\n[interrupt] 状态已保存，可再次运行续跑")
        return 130


def _setup_console() -> None:
    """Windows: make the console render UTF-8 (avoids GBK mojibake for Chinese)."""
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:  # noqa: BLE001
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except Exception:  # noqa: BLE001
            pass


def _is_admin() -> bool:
    if sys.platform != "win32":
        return True
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:  # noqa: BLE001
        return False


def main(argv: list[str] | None = None) -> int:
    _setup_console()
    ap = argparse.ArgumentParser(description="无人值守 Cursor 编码循环")
    ap.add_argument("--config", type=Path, default=config_mod.DEFAULT_CONFIG)
    ap.add_argument("--project", type=str, help="目标项目目录（覆盖 config.json）")
    ap.add_argument("--mode", choices=["dry-run", "live", "limit-sim"])
    ap.add_argument("--dry-run", action="store_true", help="只读不执行（同 --mode dry-run）")
    ap.add_argument("--check-config", action="store_true", help="校验配置并退出")
    ap.add_argument("--assistant-dry-run", action="store_true", help="定位换号助手窗口/模板，不点击")
    ap.add_argument("--assistant-refresh-only", action="store_true", help="杀 Cursor 后实际点刷新并等 token 变化")
    ap.add_argument("--detect-only", action="store_true", help="只轮询检测状态，不发送")
    ap.add_argument("--detect-seconds", type=float, default=20.0)
    ap.add_argument("--inject-limit-node", action="store_true", help="向 DOM 注入假 limit 横幅（测试检测器）")
    args = ap.parse_args(argv)

    if args.project:
        config_mod.PROJECT_OVERRIDE = args.project
    cfg = Config.load(args.config)
    if args.mode:
        cfg.mode = args.mode
    if args.dry_run:
        cfg.mode = "dry-run"

    if args.check_config:
        return cmd_check_config(cfg)
    if args.assistant_dry_run:
        return cmd_assistant_dry_run(cfg)
    if args.inject_limit_node:
        return cmd_inject_limit_node(cfg)
    if args.detect_only:
        return cmd_detect_only(cfg, args.detect_seconds)
    if args.assistant_refresh_only:
        if not _is_admin():
            print("[fail] --assistant-refresh-only 需要管理员权限（换号助手要求提升）。请用管理员终端运行。")
            return 2
        return cmd_assistant_refresh_only(cfg)
    if cfg.mode == "dry-run":
        return cmd_dry_run(cfg)  # read-only: parse queue + report, no send/kill/click

    if cfg.mode in ("live", "limit-sim") and not _is_admin():
        print("[fail] live / limit-sim 模式需要管理员权限（Cursor 与换号助手都要求提升）。")
        print("       请用管理员终端运行，或双击 unattended\\run_unattended.bat（参数 live/limit-sim，启动时弹一次 UAC）。")
        return 2

    cursor_ctl.init(cfg)
    problems = cfg.validate()
    if problems:
        for p in problems:
            print("[!]", p)
        print("[fail] 配置有问题，先 --check-config")
        return 2

    print(f"[mode] {cfg.mode}  project={cfg.project_dir}")
    if cfg.mode in ("live", "limit-sim"):
        print(
            "[注意] 该模式会真实点击换号助手并切换 Cursor 账号。"
            "自动轮号绕过用量限制违反 Cursor ToS，账号存在风控/封禁风险，风险自担。"
        )
    return run(cfg)


if __name__ == "__main__":
    raise SystemExit(main())
