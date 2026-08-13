"""CursorHarness CLI —— 在当前目录使用，即对该目录执行 Harness。

用法（在目标项目目录下执行）：
    curloop run            # 无人值守运行（默认；读 FinalGoal 生成 TODO → 执行 → 续接）
    curloop plan           # 只生成 TODO.md（读 FinalGoal，不执行）
    curloop status         # 显示当前项目状态与统计（队列/运行时长/换号/对话）
    curloop stats          # 统计摘要（换号/对话/任务/账号）
    curloop watch          # 实时监控（每 3 秒刷新）
    curloop init           # 生成 FinalGoal.md / TODO.md 模板

选项：
    --mode live|limit-sim|dry-run   运行模式（默认 live）
    --no-plan                       run 时跳过"生成 TODO"（直接用已有 TODO.md）
    --project PATH                  指定项目目录（默认当前目录）
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
from . import ui  # noqa: E402
from .config import Config  # noqa: E402
from .run_state import RunState  # noqa: E402


def _cfg(project: Path, mode: str) -> Config:
    """Load config and override project + mode (context = the given directory)."""
    cfg = Config.load()
    cfg.project_dir = project
    cfg.mode = mode
    return cfg


def cmd_run(args) -> int:
    cfg = _cfg(Path(args.project), args.mode)
    if args.no_plan and not cfg.todo_file.exists():
        print(ui.err("[fail] --no-plan 但 TODO.md 不存在，无法运行"))
        return 2
    print(f"{ui.head('[curloop] run')}  {ui.paint(str(cfg.project_dir), ui.C.CYAN)}  "
          f"(mode={ui.warn(args.mode)}, plan={'off' if args.no_plan else 'on'})")
    return loop.run(cfg)


def cmd_plan(args) -> int:
    cfg = _cfg(Path(args.project), "dry-run")
    state = RunState.load(cfg.snapshot_file, cfg.event_log_file, cfg.todo_file)
    if cfg.todo_file.exists():
        print(f"{ui.dim('[curloop]')} TODO.md 已存在（{cfg.todo_file}），跳过规划；如要重新生成请先删除")
        return 0
    fresh = loop._plan_initial_todo(cfg, state)
    if fresh is not None:
        print(f"{ui.ok('[curloop] 规划完成')}，新增 {len(fresh.queue)} 个任务")
        return 0
    print(ui.warn("[curloop] 规划未生成任务（FinalGoal 缺失或 Agent 未追加）"))
    return 1


def cmd_status(args) -> int:
    ui.init()
    print(ui.status_render(observer.build_status()))
    return 0


def cmd_stats(args) -> int:
    ui.init()
    print(ui.stats_render(observer.build_status()["stats"]))
    return 0


def cmd_watch(args) -> int:
    ui.init()
    print(ui.dim("[curloop] watch：每 3 秒刷新（Ctrl-C 退出）"))
    try:
        while True:
            os.system("cls" if os.name == "nt" else "clear")
            print(ui.status_render(observer.build_status()))
            time.sleep(3)
    except KeyboardInterrupt:
        print("\n[curloop] watch 已停止")
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
            print(f"{ui.dim('[curloop]')} FinalGoal.md 已存在（{p}），跳过")
        else:
            p.write_text(INIT_GOAL, encoding="utf-8")
            created.append(str(p))
    p = Path(args.project) / "TODO.md"
    if p.exists():
        print(f"{ui.dim('[curloop]')} TODO.md 已存在（{p}），跳过")
    else:
        p.write_text(INIT_TODO, encoding="utf-8")
        created.append(str(p))
    print(f"{ui.ok('[curloop] 已创建:')} {created or ui.dim('无（都已存在）')}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    # 在 build_parser 内构造（用当前 _ANSI 状态），避免模块级常量固化转义码
    epilog = f"""
{ui.head('示例')}
  curloop run                       在当前目录无人值守运行（读 FinalGoal 生成 TODO → 执行 → 续接）
  curloop run --no-plan             直接用已有 TODO.md（跳过生成规划）
  curloop run --mode limit-sim      换号链路测试（真实点击换号助手）
  curloop status                    查看状态与统计（换号/对话/队列/事件）
  curloop stats                     统计摘要
  curloop watch                     实时监控（每 3 秒刷新）
  curloop plan                      只生成 TODO.md
  curloop init --final-goal         生成 FinalGoal.md + TODO.md 模板

{ui.head('说明')}
  · 在哪个目录运行，就对哪个目录执行 Harness（当前目录 = 目标项目）。
  · 首次运行需要 FinalGoal.md：curloop init --final-goal 生成模板后编辑。
  · 无人值守会自动：关弹窗 / 换号 / 每完成一个任务 git commit / 队列空自动续任务。
  · 观察面板：python dashboard.py 或双击 unattended\\dashboard.bat → http://127.0.0.1:8765
"""
    ap = argparse.ArgumentParser(
        prog="curloop",
        description=ui.head("CursorHarness CLI：持续 Cursor 对话循环 + 自动换号"),
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="无人值守运行（默认；读 FinalGoal 生成 TODO → 执行 → 续接）")
    sub.add_parser("plan", help="只生成 TODO.md（读 FinalGoal，不执行）")
    sub.add_parser("status", help="显示当前项目状态与统计")
    sub.add_parser("stats", help="统计摘要（换号/对话/完成）")
    sub.add_parser("watch", help="实时监控（每 3 秒刷新）")
    sub.add_parser("init", help="生成 FinalGoal.md / TODO.md 模板")
    for name in ("run", "plan", "status", "stats", "watch", "init"):
        p = sub.choices[name]
        p.add_argument("--mode", choices=["live", "limit-sim", "dry-run"], default="live",
                       help="运行模式（默认 live）")
        p.add_argument("--project", default=os.getcwd(),
                       help="目标项目目录（默认当前目录）")
        p.add_argument("--no-plan", action="store_true",
                       help="run 时跳过生成 TODO（用已有 TODO.md）")
    sub.choices["init"].add_argument("--final-goal", action="store_true",
                                     help="同时生成 FinalGoal.md")
    return ap


def main(argv: list[str] | None = None) -> int:
    ui.init()  # 先初始化颜色（isatty 判定），避免 help 泄漏转义码
    ap = build_parser()
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
