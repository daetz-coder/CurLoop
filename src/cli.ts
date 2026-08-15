import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Config, load as loadConfig } from './config';
import * as loop from './loop';
import { expandGoalPrompt } from './prompts';
import { buildStatus, fmtTs, loadEvents, shortDetail } from './observer';
import * as ui from './ui';
import { RunState } from './runState';
import { parseAll } from './todoQueue';

/** CursorHarness CLI —— 在当前目录使用，即对该目录执行 Harness。
 *
 * 用法（在目标项目目录下执行）：
 *   curloop run            # 无人值守运行（默认；读 FinalGoal 生成 TODO → 执行 → 续接）
 *   curloop plan           # 只生成 TODO.md（读 FinalGoal，不执行）
 *   curloop status         # 显示当前项目状态与统计
 *   curloop stats          # 统计摘要
 *   curloop watch          # 实时监控（每 3 秒刷新）
 *   curloop init           # 生成 FinalGoal.md / TODO.md 模板
 *   curloop tasks|log|stop|report   # REPL 内也可用 /tasks /log /stop /report
 */

export interface CliArgs {
  cmd?: string;
  mode?: string;
  project?: string;
  noPlan?: boolean;
  noExpand?: boolean;
  yes?: boolean;
  finalGoal?: boolean;
  maxTasks?: number;
  count?: number;
  port?: number;
  'no-open'?: boolean;
  _: string[];
  [key: string]: unknown;
}

function cfgFor(project: string, mode: string): Config {
  const cfg = loadConfig(null);
  cfg.projectDir = path.resolve(project);
  cfg.mode = mode;
  return cfg;
}

function projectProfile(project: string): { hasGoal: boolean; hasTodo: boolean; isGit: boolean } {
  return {
    hasGoal: fs.existsSync(path.join(project, 'FinalGoal.md')),
    hasTodo: fs.existsSync(path.join(project, 'TODO.md')),
    isGit: fs.existsSync(path.join(project, '.git')),
  };
}

/** 单行输入：返回输入内容；EOF/Ctrl-C 返回 null。 */
function askLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans);
    });
    rl.on('close', () => resolve(null));
    rl.on('SIGINT', () => {
      rl.close();
      resolve(null);
    });
  });
}

/** 新项目引导：请用户输入最终目标，返回文本（取消返回 null）。 */
async function askGoal(project: string): Promise<string | null> {
  console.log();
  console.log(ui.head('📌 新项目检测：') + ` ${ui.paint(project, ui.C.CYAN)}`);
  console.log(ui.dim('   未找到 FinalGoal.md / TODO.md，需要先初始化。'));
  console.log('   请输入本项目的【最终目标】（可多行，空行结束；Ctrl-C 取消）：');
  const lines: string[] = [];
  for (;;) {
    const line = await askLine(ui.paint('  > ', ui.C.CYAN));
    if (line === null) {
      console.log('\n已取消');
      return null;
    }
    if (!line.trim()) break;
    lines.push(line.trim());
  }
  if (!lines.length) {
    console.log(ui.warn('未输入目标，取消初始化'));
    return null;
  }
  return lines.join('\n');
}

function writeFinalGoal(project: string, text: string): string {
  const p = path.join(project, 'FinalGoal.md');
  const content =
    '# 最终目标（FinalGoal）\n\n' +
    '> 由 curloop 初始化生成；本文件是仓库的最高级规划。\n\n' +
    '## 最终目标\n\n' +
    `${text}\n\n` +
    '## 硬门槛 / 交付物\n\n' +
    '- [ ] （待补充，后续规划会对照本目标生成 TODO）\n';
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** 旧项目：显示任务分析，确认后直接续跑。 */
async function confirmResume(cfg: Config): Promise<boolean> {
  const todos = parseAll(cfg.todoFile);
  const pending = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  console.log();
  console.log(ui.head('📋 项目状态：') + ` ${ui.paint(cfg.projectDir, ui.C.CYAN)}`);
  console.log(
    `   ${ui.num(String(pending.length))} 待办  /  ${ui.ok(String(done.length)) + ' 已完成'}` +
      `${ui.dim('    (git: ' + (fs.existsSync(path.join(cfg.projectDir, '.git')) ? '是' : '否') + ')')}`,
  );
  for (const t of pending.slice(0, 10)) {
    console.log(`   ${ui.dim('·')} ${t.text.slice(0, 64)}`);
  }
  if (pending.length > 10) {
    console.log(`   ${ui.dim(`… 还有 ${pending.length - 10} 项`)}`);
  }
  const ans = (await askLine(ui.paint('继续运行？[Y/n] ', ui.C.CYAN))) || '';
  return ['', 'y', 'yes'].includes(ans.trim().toLowerCase());
}

/** 询问是否自动扩写（默认是）。 */
async function askExpand(): Promise<boolean> {
  const ans = (await askLine(ui.paint('需要自动扩写为完整 FinalGoal + 初始 TODO？[Y/n] ', ui.C.CYAN))) || '';
  return ['', 'y', 'yes'].includes(ans.trim().toLowerCase());
}

/** 把用户目标发给 Cursor（含我们定义的上下文），扩写生成 FinalGoal.md + TODO.md。 */
async function expandGoal(cfg: Config, goal: string): Promise<boolean> {
  console.log(ui.dim('  正在让 Cursor 扩写目标并生成规划（首次会启动/附加 Cursor）...'));
  const state = RunState.load(cfg.snapshotFile, cfg.eventLogFile, cfg.todoFile);
  const ok = await loop.sendAndWait(
    cfg,
    state,
    expandGoalPrompt(cfg.projectDir, goal),
    'expand_goal',
  );
  return ok === 'ok';
}

export async function cmdRun(args: CliArgs): Promise<number> {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  if (args.maxTasks && args.maxTasks > 0) cfg.control.maxTasks = Math.trunc(args.maxTasks);
  if (args.noPlan && !fs.existsSync(cfg.todoFile)) {
    console.log(ui.err('[fail] --no-plan 但 TODO.md 不存在，无法运行'));
    return 2;
  }

  const prof = projectProfile(cfg.projectDir);

  // 场景 A：全新项目 —— 引导输入最终目标 → 询问扩写 → 创建 FinalGoal/TODO
  if (!prof.hasGoal && !prof.hasTodo) {
    if (args.yes) {
      console.log(ui.warn('[warn] 新项目但 --yes：跳过初始化，将无规划直接结束（先 curloop init）'));
    } else {
      const goal = await askGoal(cfg.projectDir);
      if (goal === null) return 1;
      let wantExpand = false;
      if (args.mode === 'dry-run') {
        wantExpand = !args.noExpand; // 预览将采用哪种模式
        console.log(ui.dim(`  (dry-run：将按${wantExpand ? '扩写模式' : '直接模式'}处理，不会发送扩写 prompt)`));
      } else if (args.noExpand) {
        wantExpand = false;
      } else {
        wantExpand = await askExpand();
      }

      if (args.mode === 'dry-run') {
        writeFinalGoal(cfg.projectDir, goal);
        console.log(`${ui.dim('  [dry-run] 已生成模板 FinalGoal.md（' + (wantExpand ? '扩写' : '直接') + '模式预览）')}`);
      } else if (wantExpand) {
        if (await expandGoal(cfg, goal)) {
          console.log(`${ui.ok('[ok] 已通过 Cursor 扩写生成 FinalGoal.md + TODO.md')}`);
          console.log(ui.dim('      即将自动开始执行队列（Ctrl-C 可取消）'));
        } else {
          console.log(ui.warn('[warn] 扩写失败，回退为直接创建 FinalGoal.md（TODO 由首次运行生成）'));
          writeFinalGoal(cfg.projectDir, goal);
        }
      } else {
        const p = writeFinalGoal(cfg.projectDir, goal);
        console.log(`${ui.ok('[ok] 已创建 FinalGoal.md')} → ${p}`);
        console.log(ui.dim('      首次运行将读取它生成初始 TODO.md'));
      }
    }
  }
  // 场景 B：旧项目 —— 显示任务分析，确认后续跑
  else if (prof.hasTodo && !args.yes) {
    if (!(await confirmResume(cfg))) {
      console.log(ui.dim('[curloop] 已取消'));
      return 1;
    }
  }

  // 场景 C：有目标无 TODO（或 --yes 跳过询问）→ 直接进入 loop
  console.log(
    `${ui.head('[curloop] run')}  ${ui.paint(cfg.projectDir, ui.C.CYAN)}  ` +
      `(mode=${ui.warn(args.mode || 'live')}, plan=${args.noPlan ? 'off' : 'on'})`,
  );

  if (args.mode === 'dry-run') {
    console.log(ui.dim('[curloop] dry-run：仅引导与预览，不执行任务；去掉 --mode dry-run 即真正运行'));
    return 0;
  }

  return loop.run(cfg);
}

export async function cmdPlan(args: CliArgs): Promise<number> {
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, 'dry-run');
  const state = RunState.load(cfg.snapshotFile, cfg.eventLogFile, cfg.todoFile);
  if (fs.existsSync(cfg.todoFile)) {
    console.log(`${ui.dim('[curloop]')} TODO.md 已存在（${cfg.todoFile}），跳过规划；如要重新生成请先删除`);
    return 0;
  }
  const fresh = await loop.planInitialTodo(cfg, state);
  if (fresh !== null) {
    console.log(`${ui.ok('[curloop] 规划完成')}，新增 ${fresh.queue.length} 个任务`);
    return 0;
  }
  console.log(ui.warn('[curloop] 规划未生成任务（FinalGoal 缺失或 Agent 未追加）'));
  return 1;
}

export async function cmdStatus(args: CliArgs): Promise<number> {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  console.log(ui.statusRender(buildStatus(cfg.projectDir, cfg.stateDir)));
  return 0;
}

export async function cmdStats(args: CliArgs): Promise<number> {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  console.log(ui.statsRender(buildStatus(cfg.projectDir, cfg.stateDir).stats));
  return 0;
}

export async function cmdWatch(args: CliArgs): Promise<number> {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  console.log(ui.dim('[curloop] watch：每 3 秒刷新（Ctrl-C 退出）'));
  return new Promise<number>((resolve) => {
    const onSigint = () => {
      clearInterval(timer);
      console.log('\n[curloop] watch 已停止');
      resolve(0);
    };
    process.once('SIGINT', onSigint);
    const render = () => {
      try {
        console.clear();
        console.log(ui.statusRender(buildStatus(cfg.projectDir, cfg.stateDir)));
      } catch {
        /* ignore */
      }
    };
    render();
    const timer = setInterval(render, 3000);
    timer.unref?.();
  });
}

const INIT_TODO = `# 待办清单

- [ ] 示例任务：检查 README.md，把安装说明里的版本号更新为最新
`;

const INIT_GOAL = `# 最终目标（FinalGoal）

> 本文件是仓库的最高级规划。首次运行（无 TODO.md）时会读取本文件生成初始 TODO.md；
> 队列空且轻量规划无新任务时，会对照本文件重新规划；目标完成（两层均无新任务）后停止。

## 最终目标

（在这里描述你要达成的最终目标与验收标准）

## 硬门槛 / 交付物

- [ ] 交付物 1
- [ ] 交付物 2
`;

export { INIT_GOAL, INIT_TODO };

export function cmdInit(args: CliArgs): number {
  const project = path.resolve(args.project || process.cwd());
  const created: string[] = [];
  if (args.finalGoal) {
    const p = path.join(project, 'FinalGoal.md');
    if (fs.existsSync(p)) {
      console.log(`${ui.dim('[curloop]')} FinalGoal.md 已存在（${p}），跳过`);
    } else {
      fs.writeFileSync(p, INIT_GOAL, 'utf-8');
      created.push(p);
    }
  }
  const p = path.join(project, 'TODO.md');
  if (fs.existsSync(p)) {
    console.log(`${ui.dim('[curloop]')} TODO.md 已存在（${p}），跳过`);
  } else {
    fs.writeFileSync(p, INIT_TODO, 'utf-8');
    created.push(p);
  }
  console.log(`${ui.ok('[curloop] 已创建:')} ${created.length ? created.join(', ') : ui.dim('无（都已存在）')}`);
  return 0;
}

export async function cmdTasks(args: CliArgs): Promise<number> {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  const rep = buildStatus(cfg.projectDir, cfg.stateDir);
  console.log(ui.head('TODO 队列') + `  ${ui.dim('(' + rep.queue.length + ' 项)')}`);
  if (!rep.queue.length) {
    console.log(`  ${ui.dim('（空）')}`);
    return 0;
  }
  const markMap: Record<string, string> = {
    done: ui.ok('✓ done'),
    running: ui.warn('▶ running'),
    pending: ui.dim('○ pending'),
    skipped: ui.err('✗ skipped'),
  };
  for (const q of rep.queue) {
    const st = q.status ?? '';
    console.log(`  ${markMap[st] ?? ui.dim(st)} ${q.text}`);
  }
  return 0;
}

export async function cmdLog(args: CliArgs): Promise<number> {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  const n = Math.max(1, Math.min(200, Number(args.count ?? 20)));
  const evs = loadEvents(cfg.projectDir, cfg.stateDir).slice(-n).reverse();
  if (!evs.length) {
    console.log(ui.dim('[log] runstate 暂无事件'));
    return 0;
  }
  for (const e of evs) {
    const detail = shortDetail(e);
    console.log(`  ${ui.dim(fmtTs(e['ts']))}  ${String(e['event'] ?? '')}${detail ? '  ' + ui.dim(detail) : ''}`);
  }
  return 0;
}

export function cmdStop(args: CliArgs): number {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  const sp = loop.stopFilePath(cfg);
  fs.writeFileSync(sp, `stop requested at ${new Date().toISOString()}\n`, 'utf-8');
  console.log(ui.ok('[stop] 已创建停止文件') + `  ${ui.dim(sp)}`);
  console.log(ui.dim('  运行中的 curloop 会在下一个轮询周期检测到并优雅中止（退出码 2，watchdog 不重启）。删除该文件可取消。'));
  return 0;
}

export function cmdReport(args: CliArgs): number {
  ui.init();
  const project = path.resolve(args.project || process.cwd());
  const cfg = cfgFor(project, args.mode || 'live');
  const rp = path.join(cfg.projectStateDir, 'report.json');
  if (!fs.existsSync(rp)) {
    console.log(ui.warn('[report] 暂无结束报告（run 尚未正常结束，或该目录无 runstate）'));
    return 1;
  }
  console.log(fs.readFileSync(rp, 'utf-8'));
  return 0;
}

// ---------------------------------------------------------------------- REPL ----
const ALL_SLASH = ['/help', '/status', '/stats', '/run', '/plan', '/watch', '/init', '/tasks', '/log', '/stop', '/report', '/project', '/exit', '/quit'];

function slashHelp(): string {
  const c = ui.C;
  return (
    `${ui.head('✦ 可用命令')}\n` +
    `  ${ui.paint('❯', c.CYAN)} /help        显示本帮助\n` +
    `  ${ui.paint('❯', c.CYAN)} /status      查看状态与统计（换号 / 对话 / 队列 / 事件）\n` +
    `  ${ui.paint('❯', c.CYAN)} /stats       统计摘要\n` +
    `  ${ui.paint('❯', c.CYAN)} /tasks       查看当前 TODO 队列\n` +
    `  ${ui.paint('❯', c.CYAN)} /log [N]     最近 N 条事件（默认 20）\n` +
    `  ${ui.paint('❯', c.CYAN)} /run         无人值守运行（--yes / --no-plan / --max-tasks N）\n` +
    `  ${ui.paint('❯', c.CYAN)} /plan        只生成 TODO.md（读 FinalGoal）\n` +
    `  ${ui.paint('❯', c.CYAN)} /watch       实时监控（Ctrl-C 返回）\n` +
    `  ${ui.paint('❯', c.CYAN)} /init        生成 FinalGoal.md / TODO.md 模板（--final-goal）\n` +
    `  ${ui.paint('❯', c.CYAN)} /stop        创建 STOP 文件，优雅中止正在运行的 loop（退出码 2）\n` +
    `  ${ui.paint('❯', c.CYAN)} /report      查看上次运行的结束报告（report.json）\n` +
    `  ${ui.paint('❯', c.CYAN)} /project <路径>  切换目标项目\n` +
    `  ${ui.paint('❯', c.CYAN)} /exit        退出（或 Ctrl-C / Ctrl-D）\n`
  );
}

const LOGO = [
  ' ██████╗██╗   ██╗██████╗ ██╗      ██████╗  ██████╗  ██████╗',
  '██╔════╝██║   ██║██╔══██╗██║     ██╔═══██╗██╔═══██╗██╔═══██╗',
  '██║     ██║   ██║██████╔╝██║     ██║   ██║██║   ██║██████╔╝',
  '██║     ██║   ██║██╔══██╗██║     ██║   ██║██║   ██║██╔════╝',
  '╚██████╗╚██████╔╝██║  ██║███████╗╚██████╔╝╚██████╔╝██║',
  ' ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝  ╚═════╝ ╚═╝',
].join('\n');

function todoCounts(project: string): [number, number] {
  try {
    const cfg = loadConfig(null);
    cfg.projectDir = path.resolve(project);
    const todos = parseAll(cfg.todoFile);
    return [todos.filter((t) => !t.done).length, todos.length];
  } catch {
    return [0, 0];
  }
}

function banner(project: string): string {
  const c = ui.C;
  let st: Record<string, unknown> = {};
  try {
    const cfg = loadConfig(null);
    cfg.projectDir = path.resolve(project);
    st = buildStatus(cfg.projectDir, cfg.stateDir).stats as unknown as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  const [pending, total] = todoCounts(project);
  const switches = Number(st['switches'] ?? 0);
  const sends = Number(st['sends'] ?? 0);
  const done = Number(st['tasks_done'] ?? 0);
  const mode = st['mode'] ?? 'live';
  const lines = [
    ui.paint(LOGO, c.CYAN, true),
    ui.dim('  持续 Cursor 对话循环 + 自动换号 · 目标驱动 · 无人值守 · git commit'),
    ui.dim('  ' + '─'.repeat(58)),
    `  ${ui.dim('项目')}   ${ui.paint(project, c.CYAN)}`,
    `  ${ui.dim('状态')}   ${ui.head('换号')} ${ui.num(String(switches))}   ` +
      `${ui.head('对话')} ${ui.num(String(sends))}   ${ui.head('完成')} ${ui.ok(String(done))}   ` +
      `${ui.head('待办')} ${ui.warn(`${pending}/${total}`)}`,
    `  ${ui.dim('模式')}   ${ui.ok(String(mode))}   ${ui.dim('（/run --mode limit-sim 可做换号链路测试）')}`,
    ui.dim('  ' + '─'.repeat(58)),
    `  ${ui.head('快速开始')}   ` +
      `${ui.paint('❯ /run', c.YELLOW)} 开始无人值守   ` +
      `${ui.paint('❯ /status', c.YELLOW)} 查看状态   ` +
      `${ui.paint('❯ /project <路径>', c.YELLOW)} 切换项目   ` +
      `${ui.paint('❯ /help', c.YELLOW)} 全部命令`,
  ];
  return lines.join('\n');
}

function slashArgs(cmd: string, rest: string, project: string): CliArgs {
  const a: CliArgs = { _: [cmd] };
  a.mode = 'live';
  a.project = project;
  a.noPlan = rest.includes('--no-plan');
  a.noExpand = rest.includes('--no-expand');
  a.finalGoal = rest.includes('--final-goal');
  a.yes = rest.includes('--yes');
  const m = /--mode\s+(\S+)/.exec(rest);
  if (m) a.mode = m[1];
  const mt = /--max-tasks\s+(\d+)/.exec(rest);
  if (mt) a.maxTasks = Number(mt[1]);
  const trimmed = rest.trim();
  if (/^\d+$/.test(trimmed)) a.count = Number(trimmed);
  return a;
}

export async function repl(project?: string): Promise<number> {
  ui.init();
  let current = project ? path.resolve(project) : process.cwd();
  console.log();
  console.log(banner(current));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => {
      const hits = ALL_SLASH.filter((c) => c.startsWith(line.trim()));
      return [hits.length ? hits : ALL_SLASH, line.trim()];
    },
  });

  const handlers: Record<string, (a: CliArgs) => number | Promise<number>> = {
    '/status': cmdStatus,
    '/stats': cmdStats,
    '/run': cmdRun,
    '/plan': cmdPlan,
    '/watch': cmdWatch,
    '/init': cmdInit,
    '/tasks': cmdTasks,
    '/log': cmdLog,
    '/stop': cmdStop,
    '/report': cmdReport,
  };

  let done = false;
  const prompt = (): void => {
    if (done) return;
    try {
      rl.setPrompt(ui.paint('❯ ', ui.C.CYAN));
      rl.prompt();
    } catch {
      /* interface already closed */
    }
  };
  prompt();

  return new Promise<number>((resolve) => {
    const finish = (v: number): void => {
      if (done) return;
      done = true;
      resolve(v);
    };

    // 串行处理：async handler 未结束时 readline 可能已派发下一行（管道输入），
    // 若其间 /exit 关闭了接口，早先 handler 恢复后会 prompt() 到已关闭的 rl。
    let chain: Promise<void> = Promise.resolve();
    rl.on('line', (raw) => {
      chain = chain.then(() => handleLine(raw)).catch(() => undefined);
    });
    rl.on('SIGINT', () => {
      console.log(ui.dim('\n退出 curloop'));
      rl.close();
      finish(0);
    });
    rl.on('close', () => finish(0));

    async function handleLine(raw: string): Promise<void> {
      const line = raw.trim();
      if (!line) {
        prompt();
        return;
      }
      if (!line.startsWith('/')) {
        console.log(ui.warn(`  ✗ 未知输入：${line}  （命令以 / 开头，如 /status；/help 查看）`));
        prompt();
        return;
      }
      const sp = line.indexOf(' ');
      const cmd = sp === -1 ? line : line.slice(0, sp);
      const rest = sp === -1 ? '' : line.slice(sp + 1);
      // 前缀自动补全：唯一匹配 → 归一 cmd；多个匹配 → 列出候选
      let normalized = cmd;
      if (!['/exit', '/quit', '/help', '/project'].includes(cmd) && !handlers[cmd]) {
        const matches = ALL_SLASH.filter((c) => c.startsWith(cmd));
        if (matches.length === 1) {
          console.log(`  ${ui.dim('↳ 匹配')} ${ui.paint(matches[0], ui.C.YELLOW)}`);
          normalized = matches[0];
        } else if (matches.length > 1) {
          console.log(`  ${ui.dim('↳ 匹配多个：')} ${ui.paint(matches.join(' '), ui.C.YELLOW)}`);
          prompt();
          return;
        }
      }
      if (normalized === '/exit' || normalized === '/quit') {
        console.log(ui.dim('退出 curloop'));
        rl.close();
        finish(0);
        return;
      }
      if (normalized === '/help') {
        console.log();
        console.log(slashHelp());
        console.log();
        prompt();
        return;
      }
      if (normalized === '/project') {
        if (rest.trim()) {
          current = path.resolve(rest.trim());
          console.log(`  ${ui.ok('✓ 已切换项目')}  ${ui.paint(current, ui.C.CYAN)}`);
        } else {
          console.log(`  ${ui.dim('当前项目')}  ${ui.paint(current, ui.C.CYAN)}`);
        }
        prompt();
        return;
      }
      const fn = handlers[normalized];
      if (!fn) {
        console.log(ui.warn(`  ✗ 未知命令：${normalized}  （/help 查看）`));
        prompt();
        return;
      }
      console.log();
      try {
        const rc = await fn(slashArgs(normalized, rest, current));
        console.log(ui.dim(`  ─ 返回 ${rc} ─`));
      } catch (e) {
        console.log(ui.err(`  ✗ 命令出错：${String(e)}`));
      }
      console.log();
      prompt();
    }
  });
}

export async function main(argv: string[]): Promise<number> {
  ui.init(); // 先初始化颜色（isatty 判定），避免 help 泄漏转义码
  if (!argv.length || argv[0].startsWith('-')) {
    // 无子命令 → 交互式主 CLI；或以 - 开头 → 交给 loop 直通入口
    if (!argv.length) return repl();
    return loop.main(argv);
  }
  const minimist = require('minimist') as (args: string[], opts?: unknown) => CliArgs;
  const args = minimist(argv, {
    string: ['mode', 'project'],
    boolean: ['no-plan', 'no-expand', 'yes', 'final-goal'],
    default: { project: process.cwd() },
  });
  const cmd = args._[0] || args.cmd;
  const cli: CliArgs = {
    _: args._,
    cmd,
    mode: args.mode as string | undefined,
    project: args.project as string | undefined,
    noPlan: Boolean(args['no-plan']),
    noExpand: Boolean(args['no-expand']),
    yes: Boolean(args.yes),
    finalGoal: Boolean(args['final-goal']),
    maxTasks: args['max-tasks'] !== undefined ? Math.max(0, Math.trunc(Number(args['max-tasks']))) : undefined,
    port: args.port !== undefined ? Number(args.port) : undefined,
    'no-open': Boolean(args['no-open']),
  };
  switch (cmd) {
    case 'run':
      return cmdRun(cli);
    case 'plan':
      return cmdPlan(cli);
    case 'status':
      return cmdStatus(cli);
    case 'stats':
      return cmdStats(cli);
    case 'watch':
      return cmdWatch(cli);
    case 'init':
      return cmdInit(cli);
    case 'web':
      return cmdWeb(cli);
    default:
      console.log(
        `${ui.head('示例')}\n` +
          '  curloop run                       在当前目录无人值守运行\n' +
          '  curloop run --no-plan             直接用已有 TODO.md（跳过生成规划）\n' +
          '  curloop web [--port 3080]         打开 Web 界面（可视化 + 远程控制，仿 dsh web）\n' +
          '  curloop status                    查看状态与统计\n' +
          '  curloop stats                     统计摘要\n' +
          '  curloop watch                     实时监控（每 3 秒刷新）\n' +
          '  curloop plan                      只生成 TODO.md\n' +
          '  curloop init --final-goal         生成 FinalGoal.md + TODO.md 模板\n',
      );
      return 0;
  }
}

export async function cmdWeb(args: CliArgs): Promise<number> {
  const { webMain } = await import('./web');
  return webMain({
    port: Number(args.port ?? 3080),
    project: (args.project as string | undefined) || process.cwd(),
    mode: args.mode as string | undefined,
    'no-open': Boolean(args['no-open']),
  });
}
