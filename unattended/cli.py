"""CursorHarness CLI —— 在当前目录使用，即对该目录执行 Harness。

用法（在目标项目目录下执行）：
    python -m unattended.cli run            # 无人值守运行（默认；读 FinalGoal 生成 TODO → 执行 → 续接）
    python -m unattended.cli plan           # 只生成 TODO.md（读 FinalGoal，不执行）
    python -m unattended.cli status         # 显示当前项目状态与统计（队列/运行时长/换号/对话）
    python -m unattended.cli stats          # 统计摘要（换号/对话/任务/账号）
    python -m unattended.cli watch          # 实时监控（每 3 秒刷新 status）
    python -m unattended.cli init           # 生成 FinalGoal.md / TODO.md 模板

选项：
    --mode live|limit-sim|dry-run   运行模式（默认 live）
    --no-plan                       run 时跳过"生成 TODO"（直接用已有 TODO.md）
    --project PATH                  指定项目目录（默认当前目录）
    --port N                        watch/status 检查面板端口（默认 8765，仅提示）
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

# 允许从任意目录直接运行本文件（python D:\...\unattended\cli.py），
# 以及保持"当前目录 = 目标项目"的语义（不 cd）。
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from . import loop  # noqa: E402
from . import observer  # noqa: E402
from .config import Config  # noqa: E402
from .run_state import RunState  # noqa: E402


def _cfg(project: Path, mode: str) -> Config:
    """Load config and override project + mode (context = the given directory)."""
    cfg = Config.load()
    cfg.project_dir = project
    cfg.mode = mode
    return cfg


def _print_status(d: dict) -> None:
    s = d["stats"]
    print("=" * 60)
    print(f"项目: {s.get('project') or '-'}   模式: {s.get('mode') or '-'}   已运行: {d.get('running') or '-'}")
    print("-" * 60)
    print(f"换号次数: {s['switches']}   (成功 {s['switch_ok']} / 失败 {s['switch_failed']})")
    if s["emails"]:
        print(f"账号记录: {', '.join(s['emails'][-3:])}")
    print(f"对话发送: {s['sends']}   完成任务: {s['tasks_done']}   自动续接: {s['extend_ok']}")
    print(f"TODO 队列: {len(d['queue'])} 项")
    for q in d["queue"]:
        print(f"   [{q['status']}] {q['text']}")
    print("-" * 60)
    print("最近事件:")
    for e in d["recent"][:10]:
        print(f"   {e['t']}  {e['event']:<22} {e['detail']}")
    print("=" * 60)


def cmd_run(args) -> int:
    cfg = _cfg(Path(args.project), args.mode)
    # 上下文即路径：项目 = 当前目录（已在 _cfg 设置）
    if args.no_plan and not cfg.todo_file.exists():
        print("[fail] --no-plan 但 TODO.md 不存在，无法运行")
        return 2
    print(f"[cli] run  {cfg.project_dir}  (mode={cfg.mode}, plan={'off' if args.no_plan else 'on'})")
    return loop.run(cfg)


def cmd_plan(args) -> int:
    cfg = _cfg(Path(args.project), "dry-run")
    state = RunState.load(cfg.snapshot_file, cfg.event_log_file, cfg.todo_file)
    if cfg.todo_file.exists():
        print(f"[cli] TODO.md 已存在（{cfg.todo_file}），跳过规划；如要重新生成请先删除")
        return 0
    fresh = loop._plan_initial_todo(cfg, state)
    if fresh is not None:
        print(f"[cli] 规划完成，新增 {len(fresh.queue)} 个任务")
        return 0
    print("[cli] 规划未生成任务（FinalGoal 缺失或 Agent 未追加）")
    return 1


def cmd_status(args) -> int:
    print(f"[cli] status  {os.getcwd()}")
    _print_status(observer.build_status())
    return 0


def cmd_stats(args) -> int:
    s = observer.build_status()["stats"]
    print(f"换号 {s['switches']}（成功 {s['switch_ok']} / 失败 {s['switch_failed']}） | "
          f"对话 {s['sends']} | 完成 {s['tasks_done']} | 续接 {s['extend_ok']}")
    if s["emails"]:
        print("账号:", ", ".join(s["emails"]))
    return 0


def cmd_watch(args) -> int:
    print("[cli] watch：每 3 秒刷新（Ctrl-C 退出）")
    try:
        while True:
            os.system("cls" if os.name == "nt" else "clear")
            _print_status(observer.build_status())
            time.sleep(3)
    except KeyboardInterrupt:
        print("\n[cli] watch 已停止")
    return 0


INIT_TODO = """# 待办清单

- [ ] 示例任务：检查 README.md，把安装说明里的版本号更新为最新
"""
INIT_GOAL = """# 最终目标（FinalGoal）

> 本文件是仓库的最高级规划。首次运行（无 TODO.md）时会读取本文件生成初始 TODO.md；
> 队列空且轻量规划无新任务时，会对照本文件重新规划；目标完成（两层均无新任务）后停止。

## 最终目标

（在这里描述你要达成的最终目标与验收标准）

## 硬门槛 / 交付物

- [ ] 交付物 1
- [ ] 交付物 2
"""


def cmd_init(args) -> int:
    created = []
    if args.final_goal:
        p = Path(args.project) / "FinalGoal.md"
        if p.exists():
            print(f"[cli] FinalGoal.md 已存在（{p}），跳过")
        else:
            p.write_text(INIT_GOAL, encoding="utf-8")
            created.append(str(p))
    p = Path(args.project) / "TODO.md"
    if p.exists():
        print(f"[cli] TODO.md 已存在（{p}），跳过")
    else:
        p.write_text(INIT_TODO, encoding="utf-8")
        created.append(str(p))
    print("[cli] 已创建:", created or "无（都已存在）")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="harness", description="CursorHarness CLI：在当前目录对目标项目执行无人值守")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, help_txt in (
        ("run", "无人值守运行（默认；读 FinalGoal 生成 TODO → 执行 → 续接）"),
        ("plan", "只生成 TODO.md（读 FinalGoal，不执行）"),
        ("status", "显示当前项目状态与统计"),
        ("stats", "统计摘要"),
        ("watch", "实时监控（每 3 秒刷新）"),
        ("init", "生成 FinalGoal.md / TODO.md 模板"),
    ):
        p = sub.add_parser(name, help=help_txt)
        p.add_argument("--mode", choices=["live", "limit-sim", "dry-run"], default="live")
        p.add_argument("--project", default=os.getcwd(), help="目标项目目录（默认当前目录）")
        p.add_argument("--no-plan", action="store_true", help="run 时跳过生成 TODO")
    sub.choices["init"].add_argument("--final-goal", action="store_true", help="同时生成 FinalGoal.md")

    args = ap.parse_args(argv)
    if args.cmd == "run":
        return cmd_run(args)
    if args.cmd == "plan":
        return cmd_plan(args)
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "stats":
        return cmd_stats(args)
    if args.cmd == "watch":
        return cmd_watch(args)
    if args.cmd == "init":
        return cmd_init(args)
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
