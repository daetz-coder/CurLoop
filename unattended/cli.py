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


def _project_profile(project: Path) -> dict:
    return {
        "has_goal": (project / "FinalGoal.md").exists(),
        "has_todo": (project / "TODO.md").exists(),
        "is_git": (project / ".git").exists(),
    }


def _ask_goal(project: Path) -> str | None:
    """新项目引导：请用户输入最终目标，返回文本（取消返回 None）。"""
    print()
    print(ui.head("📌 新项目检测：") + f" {ui.paint(str(project), ui.C.CYAN)}")
    print(ui.dim("   未找到 FinalGoal.md / TODO.md，需要先初始化。"))
    print("   请输入本项目的【最终目标】（可多行，空行结束；Ctrl-C 取消）：")
    lines: list[str] = []
    try:
        while True:
            try:
                line = input(ui.paint("  > ", ui.C.CYAN))
            except EOFError:
                break
            if not line.strip():
                break
            lines.append(line.strip())
    except KeyboardInterrupt:
        print("\n已取消")
        return None
    if not lines:
        print(ui.warn("未输入目标，取消初始化"))
        return None
    return "\n".join(lines)


def _write_final_goal(project: Path, text: str) -> Path:
    p = project / "FinalGoal.md"
    content = (
        "# 最终目标（FinalGoal）\n\n"
        "> 由 curloop 初始化生成；本文件是仓库的最高级规划。\n\n"
        "## 最终目标\n\n"
        f"{text}\n\n"
        "## 硬门槛 / 交付物\n\n"
        "- [ ] （待补充，后续规划会对照本目标生成 TODO）\n"
    )
    p.write_text(content, encoding="utf-8")
    return p


def _confirm_resume(cfg: Config) -> bool:
    """旧项目：显示任务分析，确认后直接续跑。"""
    from .todo_queue import parse_all

    todos = parse_all(cfg.todo_file)
    pending = [t for t in todos if not t.done]
    done = [t for t in todos if t.done]
    print()
    print(ui.head("📋 项目状态：") + f" {ui.paint(str(cfg.project_dir), ui.C.CYAN)}")
    print(f"   {ui.num(str(len(pending)))} 待办  /  {ui.ok(str(len(done))) + ' 已完成'}"
          f"{ui.dim('    (git: ' + ('是' if (cfg.project_dir / '.git').exists() else '否') + ')')}")
    for t in pending[:10]:
        print(f"   {ui.dim('·')} {t.text[:64]}")
    if len(pending) > 10:
        print(f"   {ui.dim(f'… 还有 {len(pending) - 10} 项')}")
    try:
        ans = input(ui.paint("继续运行？[Y/n] ", ui.C.CYAN)).strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    return ans in ("", "y", "yes")


EXPAND_PROMPT = (
    "项目：{project}\n"
    "用户为本项目定义了以下最终目标（简短描述）：\n"
    "--- 用户目标 ---\n{goal}\n--- 用户目标结束 ---\n"
    "请基于此目标在项目根目录完成初始化规划：\n"
    "1) 创建 FinalGoal.md：把目标扩写为完整规划（最终目标、硬门槛/交付物、验收标准、里程碑），"
    "定位为本仓库的最高级规划。\n"
    "2) 创建 TODO.md：根据 FinalGoal 列出当前最优先的 3~5 个具体可执行任务（`- [ ]` 格式）。\n"
    "3) 完成后回复：已完成规划。\n"
    "若文件已存在则更新而不是覆盖。"
)


def _ask_expand() -> bool:
    """询问是否自动扩写（默认是）。"""
    try:
        ans = input(ui.paint("需要自动扩写为完整 FinalGoal + 初始 TODO？[Y/n] ", ui.C.CYAN)).strip().lower()
    except (EOFError, KeyboardInterrupt):
        return True
    return ans in ("", "y", "yes")


def _expand_goal(cfg: Config, goal: str) -> bool:
    """把用户目标发给 Cursor（含我们定义的上下文），扩写生成 FinalGoal.md + TODO.md。"""
    print(ui.dim("  正在让 Cursor 扩写目标并生成规划（首次会启动/附加 Cursor）..."))
    state = RunState.load(cfg.snapshot_file, cfg.event_log_file, cfg.todo_file)
    ok = loop._send_and_wait(
        cfg, state,
        EXPAND_PROMPT.format(project=cfg.project_dir, goal=goal),
        "expand_goal",
    )
    return ok


def cmd_run(args) -> int:
    ui.init()
    cfg = _cfg(Path(args.project), args.mode)
    if args.no_plan and not cfg.todo_file.exists():
        print(ui.err("[fail] --no-plan 但 TODO.md 不存在，无法运行"))
        return 2

    prof = _project_profile(cfg.project_dir)

    # 场景 A：全新项目 —— 引导输入最终目标 → 询问扩写 → 创建 FinalGoal/TODO
    if not prof["has_goal"] and not prof["has_todo"]:
        if args.yes:
            print(ui.warn("[warn] 新项目但 --yes：跳过初始化，将无规划直接结束（先 curloop init）"))
        else:
            goal = _ask_goal(cfg.project_dir)
            if goal is None:
                return 1
            want_expand = False
            if args.mode == "dry-run":
                want_expand = not args.no_expand  # 预览将采用哪种模式
                print(ui.dim(f"  (dry-run：将按{'扩写模式' if want_expand else '直接模式'}处理，不会发送扩写 prompt)"))
            elif args.no_expand:
                want_expand = False
            else:
                want_expand = _ask_expand()

            if args.mode == "dry-run":
                _write_final_goal(cfg.project_dir, goal)
                print(f"{ui.dim('  [dry-run] 已生成模板 FinalGoal.md（' + ('扩写' if want_expand else '直接') + '模式预览）')}")
            elif want_expand:
                if _expand_goal(cfg, goal):
                    print(f"{ui.ok('[ok] 已通过 Cursor 扩写生成 FinalGoal.md + TODO.md')}")
                    print(ui.dim("      即将自动开始执行队列（Ctrl-C 可取消）"))
                else:
                    print(ui.warn("[warn] 扩写失败，回退为直接创建 FinalGoal.md（TODO 由首次运行生成）"))
                    _write_final_goal(cfg.project_dir, goal)
            else:
                p = _write_final_goal(cfg.project_dir, goal)
                print(f"{ui.ok('[ok] 已创建 FinalGoal.md')} → {p}")
                print(ui.dim("      首次运行将读取它生成初始 TODO.md"))

    # 场景 B：旧项目 —— 显示任务分析，确认后续跑
    elif prof["has_todo"] and not args.yes:
        if not _confirm_resume(cfg):
            print(ui.dim("[curloop] 已取消"))
            return 1

    # 场景 C：有目标无 TODO（或 --yes 跳过询问）→ 直接进入 loop（首次会生成 TODO）
    print(f"{ui.head('[curloop] run')}  {ui.paint(str(cfg.project_dir), ui.C.CYAN)}  "
          f"(mode={ui.warn(args.mode)}, plan={'off' if args.no_plan else 'on'})")

    if args.mode == "dry-run":
        print(ui.dim("[curloop] dry-run：仅引导与预览，不执行任务；去掉 --mode dry-run 即真正运行"))
        return 0

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
    print(ui.status_render(observer.build_status(project=str(Path(args.project)))))
    return 0


def cmd_stats(args) -> int:
    ui.init()
    print(ui.stats_render(observer.build_status(project=str(Path(args.project)))["stats"]))
    return 0


def cmd_watch(args) -> int:
    ui.init()
    print(ui.dim("[curloop] watch：每 3 秒刷新（Ctrl-C 退出）"))
    try:
        while True:
            os.system("cls" if os.name == "nt" else "clear")
            print(ui.status_render(observer.build_status(project=str(Path(args.project)))))
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
  · 直接输入 curloop（无参数）进入【交互式主 CLI】，内部用 /status /run /stats /help 等斜杠命令。
  · 在哪个目录运行，就对哪个目录执行 Harness（当前目录 = 目标项目）；/project 可切换。
  · 首次运行需要 FinalGoal.md：curloop init --final-goal 生成模板后编辑。
  · 无人值守会自动：关弹窗 / 换号 / 每完成一个任务 git commit / 队列空自动续任务。
"""
    ap = argparse.ArgumentParser(
        prog="curloop",
        description=ui.head("CursorHarness CLI：持续 Cursor 对话循环 + 自动换号"),
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd")  # 可省略：无子命令进入交互式 REPL（/status 等）
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
        p.add_argument("--no-expand", action="store_true",
                       help="新项目初始化时不询问扩写，直接创建 FinalGoal.md（模板形式）")
        p.add_argument("--yes", action="store_true",
                       help="跳过交互询问（非交互模式，直接运行）")
    sub.choices["init"].add_argument("--final-goal", action="store_true",
                                     help="同时生成 FinalGoal.md")
    return ap


ALL_SLASH = ["/help", "/status", "/stats", "/run", "/plan", "/watch", "/init", "/project", "/exit", "/quit"]

try:  # Python 3.13+ ships readline on Windows too — Tab completion in the REPL
    import readline  # noqa: F401

    def _complete(text: str, state: int) -> str | None:
        matches = [c for c in ALL_SLASH if c.startswith(text)]
        return matches[state] if state < len(matches) else None

    readline.set_completer(_complete)
    readline.set_completer_delims(" \t")
    readline.parse_and_bind("tab: complete")
    _HAS_READLINE = True
except Exception:  # noqa: BLE001
    _HAS_READLINE = False

try:  # prompt_toolkit: 输入 / 即自动弹出悬浮补全菜单（Windows 无 readline 的正解）
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion
    from prompt_toolkit.formatted_text import ANSI as _PT_ANSI
    from prompt_toolkit.history import InMemoryHistory

    class _SlashCompleter(Completer):
        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
            if not text.startswith("/"):
                return  # 只对 / 命令做悬浮补全，不干扰普通输入
            for c in ALL_SLASH:
                if c.startswith(text):
                    yield Completion(c, start_position=0)

    _HAS_PROMPT_TOOLKIT = True
    _pt_session: PromptSession | None = None
except Exception:  # noqa: BLE001
    _HAS_PROMPT_TOOLKIT = False


def _read_input(prompt: str) -> str:
    """终端交互优先用 prompt_toolkit（输入 / 实时弹出匹配列表），
    管道/重定向或无依赖时退回 input()，行为与原来一致。"""
    global _pt_session
    if _HAS_PROMPT_TOOLKIT and sys.stdin.isatty() and sys.stdout.isatty():
        if _pt_session is None:
            _pt_session = PromptSession(history=InMemoryHistory())
        return _pt_session.prompt(
            _PT_ANSI(prompt),
            completer=_SlashCompleter(),
            complete_while_typing=True,
        )
    return input(prompt)


def _slash_help() -> str:
    """构造帮助文本（惰性：用当前 _ANSI 状态，避免模块级固化转义码）。"""
    c = ui.C
    return f"""{ui.head('✦ 可用命令')}
  {ui.paint('❯', c.CYAN)} /help        显示本帮助
  {ui.paint('❯', c.CYAN)} /status      查看状态与统计（换号 / 对话 / 队列 / 事件）
  {ui.paint('❯', c.CYAN)} /stats       统计摘要
  {ui.paint('❯', c.CYAN)} /run         无人值守运行（--yes / --no-plan）
  {ui.paint('❯', c.CYAN)} /plan        只生成 TODO.md（读 FinalGoal）
  {ui.paint('❯', c.CYAN)} /watch       实时监控（Ctrl-C 返回）
  {ui.paint('❯', c.CYAN)} /init        生成 FinalGoal.md / TODO.md 模板（--final-goal）
  {ui.paint('❯', c.CYAN)} /project <路径>  切换目标项目
  {ui.paint('❯', c.CYAN)} /exit        退出（或 Ctrl-C / Ctrl-D）
"""


LOGO = r"""
 ██████╗██╗   ██╗██████╗ ██╗      ██████╗  ██████╗  ██████╗
██╔════╝██║   ██║██╔══██╗██║     ██╔═══██╗██╔═══██╗██╔═══██╗
██║     ██║   ██║██████╔╝██║     ██║   ██║██║   ██║██████╔╝
██║     ██║   ██║██╔══██╗██║     ██║   ██║██║   ██║██╔════╝
╚██████╗╚██████╔╝██║  ██║███████╗╚██████╔╝╚██████╔╝██║
 ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝  ╚═════╝ ╚═╝"""


def _todo_counts(project: str) -> tuple[int, int]:
    """(pending, total) from the project's TODO.md."""
    try:
        from .todo_queue import parse_all

        cfg = Config.load()
        cfg.project_dir = Path(project)
        todos = parse_all(cfg.todo_file)
        return sum(1 for t in todos if not t.done), len(todos)
    except Exception:
        return 0, 0


def _banner(project: str) -> str:
    """启动横幅：logo + 当前项目实时统计 + 快速开始。"""
    c = ui.C
    try:
        st = observer.build_status(project=project)["stats"]
    except Exception:
        st = {}
    pending, total = _todo_counts(project)
    switches = st.get("switches", 0)
    sends = st.get("sends", 0)
    done = st.get("tasks_done", 0)
    mode = st.get("mode") or "live"

    lines = [
        ui.paint(LOGO, c.CYAN, bold=True),
        ui.dim("  持续 Cursor 对话循环 + 自动换号 · 目标驱动 · 无人值守 · git commit"),
        ui.dim("  " + "─" * 58),
        f"  {ui.dim('项目')}   {ui.paint(project, c.CYAN)}",
        f"  {ui.dim('状态')}   {ui.head('换号')} {ui.num(str(switches))}   "
        f"{ui.head('对话')} {ui.num(str(sends))}   {ui.head('完成')} {ui.ok(str(done))}   "
        f"{ui.head('待办')} {ui.warn(f'{pending}/{total}')}",
        f"  {ui.dim('模式')}   {ui.ok(mode)}   {ui.dim('（/run --mode limit-sim 可做换号链路测试）')}",
        ui.dim("  " + "─" * 58),
        f"  {ui.head('快速开始')}   "
        f"{ui.paint('❯ /run', c.YELLOW)} 开始无人值守   "
        f"{ui.paint('❯ /status', c.YELLOW)} 查看状态   "
        f"{ui.paint('❯ /project <路径>', c.YELLOW)} 切换项目   "
        f"{ui.paint('❯ /help', c.YELLOW)} 全部命令",
    ]
    return "\n".join(lines)


def _slash_args(cmd: str, rest: str, project: str) -> argparse.Namespace:
    """构造与一次性 CLI 相同的参数对象。"""
    a = argparse.Namespace()
    a.mode = "live"
    a.project = project
    a.no_plan = "--no-plan" in rest
    a.no_expand = "--no-expand" in rest
    a.final_goal = "--final-goal" in rest
    a.yes = "--yes" in rest
    return a


def repl(project: str | None = None) -> int:
    """交互式主 CLI：curloop 进入后内部用 /命令 操作。"""
    ui.init()
    project = project or os.getcwd()
    print()
    print(_banner(project))
    print()
    handlers = {
        "/status": cmd_status,
        "/stats": cmd_stats,
        "/run": cmd_run,
        "/plan": cmd_plan,
        "/watch": cmd_watch,
        "/init": cmd_init,
    }
    while True:
        try:
            line = _read_input(ui.paint("❯ ", ui.C.CYAN)).strip()
        except (EOFError, KeyboardInterrupt):
            print(ui.dim("\n退出 curloop"))
            return 0
        if not line:
            continue
        if not line.startswith("/"):
            print(ui.warn(f"  ✗ 未知输入：{line}  （命令以 / 开头，如 /status；/help 查看）"))
            continue
        cmd, _, rest = line.partition(" ")
        # 前缀自动补全：不在已知命令集合时才尝试匹配。唯一匹配 → 归一 cmd 后
        # 继续向下分发（/exit /help /project 不在 handlers 里，必须由各自分支处理）；
        # 多个匹配 → 列出候选。归一必须在分发之前，绝不能用 continue 回顶部重读输入。
        if cmd not in ("/exit", "/quit", "/help", "/project") and cmd not in handlers:
            matches = [c for c in ALL_SLASH if c.startswith(cmd)]
            if len(matches) == 1:
                print(f"  {ui.dim('↳ 匹配')} {ui.paint(matches[0], ui.C.YELLOW)}")
                cmd = matches[0]
            elif len(matches) > 1:
                print(f"  {ui.dim('↳ 匹配多个：')} {ui.paint(' '.join(matches), ui.C.YELLOW)}")
                continue
        if cmd in ("/exit", "/quit"):
            print(ui.dim("退出 curloop"))
            return 0
        if cmd == "/help":
            print()
            print(_slash_help())
            print()
            continue
        if cmd == "/project":
            if rest.strip():
                project = rest.strip()
                print(f"  {ui.ok('✓ 已切换项目')}  {ui.paint(project, ui.C.CYAN)}")
            else:
                print(f"  {ui.dim('当前项目')}  {ui.paint(project, ui.C.CYAN)}")
            continue
        fn = handlers.get(cmd)
        if fn is None:
            print(ui.warn(f"  ✗ 未知命令：{cmd}  （/help 查看）"))
            continue
        print()
        rc = fn(_slash_args(cmd, rest, project))
        print(ui.dim(f"  ─ 返回 {rc} ─"))
        print()
    return 0


def main(argv: list[str] | None = None) -> int:
    ui.init()  # 先初始化颜色（isatty 判定），避免 help 泄漏转义码
    ap = build_parser()
    args = ap.parse_args(argv)
    if not args.cmd:
        # 无子命令 → 交互式主 CLI（斜杠命令）
        return repl()
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
