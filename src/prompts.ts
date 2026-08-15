import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from './config';
import type { TodoTask } from './todoQueue';
import type { RunState } from './runState';
import { buildStatus, fmtTs, loadEvents, shortDetail } from './observer';

/** 提示词 v2：任务执行契约、仓库上下文、长对话/可控性支撑。
 *
 * 设计目标（真正的 Harness）：
 * 1. 长对话：任务提示词自带「可续接」上下文（git 状态 / HARNESS_STATE.md），
 *    换号、重启、线程变长后 Agent 仍能对齐进度；另有每 N 个任务的检查点提示词。
 * 2. 可控：明确的执行纪律（先检查、逐步提交、阻塞上报），减少自由发挥。
 * 3. 最终：FinalGoal 验收提示词，队列空时做一次收尾确认。
 */

export const HARNESS_STATE_FILE = 'HARNESS_STATE.md';

// ------------------------------------------------------------ git context ----
function git(dir: string, args: string[], limit = 2000): string {
  try {
    const r = cp.spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status !== 0) return '';
    return (r.stdout || '').trim().slice(0, limit);
  } catch {
    return '';
  }
}

export interface TaskContext {
  head: string; // git log -1 --oneline
  status: string; // git status --short (cap)
  stateFile: string; // HARNESS_STATE.md 前 1.5KB
}

/** 读取仓库上下文（尽力而为，全部失败则返回空串）。 */
export function readTaskContext(projectDir: string): TaskContext {
  const ctx: TaskContext = { head: '', status: '', stateFile: '' };
  try {
    ctx.head = git(projectDir, ['log', '-1', '--oneline'], 200) || '(无提交)';
  } catch {
    ctx.head = '';
  }
  ctx.status = git(projectDir, ['status', '--short'], 1500);
  const sp = path.join(projectDir, HARNESS_STATE_FILE);
  try {
    if (fs.existsSync(sp)) {
      ctx.stateFile = fs.readFileSync(sp, 'utf-8').trim().slice(0, 1500);
    }
  } catch {
    /* ignore */
  }
  return ctx;
}

// ------------------------------------------------------------ task prompt ----
/** 自定义任务提示词覆盖：配置了 task_prompt_file 且文件存在时，完全使用文件内容。 */
function taskPromptOverride(cfg: Config): string | null {
  if (!cfg.prompt.taskPromptFile) return null;
  const p = path.isAbsolute(cfg.prompt.taskPromptFile)
    ? cfg.prompt.taskPromptFile
    : path.join(cfg.projectDir, cfg.prompt.taskPromptFile);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    console.warn(`[warn] prompt.task_prompt_file 不存在: ${p}，使用内置任务提示词`);
  } catch {
    /* ignore */
  }
  return null;
}

/** 任务提示词 v2：任务本体 + 工作纪律 + 可续接上下文（支持文件覆盖）。 */
export function buildTaskPrompt(cfg: Config, task: TodoTask): string {
  const override = taskPromptOverride(cfg);
  if (override !== null) {
    return override
      .replaceAll('{project}', cfg.projectDir)
      .replaceAll('{task}', task.text)
      .replaceAll('{retries}', String(task.retries));
  }
  let p =
    `项目：${cfg.projectDir}\n` +
    `请完成 TODO：${task.text}\n\n` +
    `【工作纪律】\n` +
    `- 先检查现状再动手：看 git 状态、最近提交与本任务相关的文件，避免重复已完成的工作。\n` +
    `- 任务要真正完成（实现 + 验证），不要中途停；如遇到无法逾越的阻塞，在 TODO.md 中\n` +
    `  追加一条说明阻塞的 ` + '`- [ ]`' + ` 任务并继续推进可做的部分，不要假装完成。\n` +
    `- 每完成一个有意义的步骤就 git commit（` + '`git add -A`' + ` + ` + '`git commit`' + `），\n` +
    `  commit message 简要描述该步骤，方便长跑续接时对齐进度。\n\n` +
    `【续接上下文】\n`;
  if (cfg.prompt.taskContext) {
    const ctx = readTaskContext(cfg.projectDir);
    if (ctx.head) p += `- 最近提交：${ctx.head}\n`;
    if (ctx.status) p += `- 未提交改动：\n${ctx.status.slice(0, 800)}\n`;
    if (ctx.stateFile) {
      p += `- HARNESS_STATE.md（之前轮次的进度小结，先读它再继续）：\n${ctx.stateFile}\n`;
    } else {
      p += `- 尚无 HARNESS_STATE.md。\n`;
    }
  }
  if (cfg.prompt.goalInTask) {
    const goal = readFinalGoalExcerpt(cfg.projectDir);
    if (goal) p += `\n【目标提示】项目最终目标（FinalGoal）要点，别忘了对齐：\n${goal}\n`;
  }
  p +=
    `\n【完成后】\n` +
    `- 若实际进展表明还有值得继续的下一步（新问题、拆出的子任务、下一步计划），\n` +
    `  请按 ` + '`- [ ] 任务描述`' + ` 格式追加到 TODO.md 末尾（每行一项、不重复已有任务；没有就跳过）。\n` +
    `- 无人值守循环会读取 TODO.md 自动继续执行新任务。`;
  return p;
}

/** FinalGoal 前段（约 1.5KB），供任务提示词目标提示与续接提示词使用。 */
function readFinalGoalExcerpt(projectDir: string): string {
  try {
    const p = path.join(projectDir, 'FinalGoal.md');
    if (!fs.existsSync(p)) return '';
    const text = fs.readFileSync(p, 'utf-8').trim();
    return text.slice(0, 1500) + (text.length > 1500 ? '\n…（截断）' : '');
  } catch {
    return '';
  }
}

// -------------------------------------------------------- restore prompt ----
/** 新会话续接提示词：线程轮转 / 恢复后，用持久记忆重建上下文。 */
export function buildRestorePrompt(cfg: Config, queueSummary: string): string {
  const ctx = readTaskContext(cfg.projectDir);
  const goal = readFinalGoalExcerpt(cfg.projectDir);
  let p =
    `项目：${cfg.projectDir}\n` +
    `这是【新会话续接】。上一个会话因上下文轮转/重启已结束，请基于以下持久记忆恢复工作状态：\n\n` +
    `【进度小结（HARNESS_STATE.md）】\n` +
    (ctx.stateFile ? `${ctx.stateFile}\n` : '（尚无）\n') +
    `\n【git 状态】\n` +
    `- 最近提交：${ctx.head || '(无提交)'}\n` +
    (ctx.status ? `- 未提交改动：\n${ctx.status.slice(0, 600)}\n` : '- 工作区干净\n');
  if (goal) p += `\n【最终目标（FinalGoal 前段）】\n${goal}\n`;
  p +=
    `\n【剩余 TODO 队列】\n${queueSummary || '（空）'}\n\n` +
    `请先阅读以上内容并确认理解当前状态，然后回复：已恢复上下文，可以继续。`;
  return p;
}

// ----------------------------------------------------- harness state file ----
/** 由 harness 自动生成的记忆文件：任何新会话/恢复都能获得最低上下文。
 *  在 run_done / 中断 / STOP / 中止 / 线程轮转前同步刷新。 */
export function writeHarnessState(cfg: Config, state: RunState): string {
  const lines: string[] = [];
  lines.push('# HARNESS_STATE.md（curloop 自动生成，供新会话/恢复续接）');
  lines.push('');
  lines.push('> 本文件由 curloop 在任务完成/检查点/结束时自动刷新；Agent 检查点提示词也可更新。');
  lines.push('');
  lines.push(`- 项目：${cfg.projectDir}`);
  lines.push(`- 更新：${new Date().toISOString()}`);
  let statsLine = `- 模式：${cfg.mode}  ·  换号：${state.switchesUsed}  ·  队列：${state.queue.length}`;
  try {
    const rep = buildStatus(cfg.projectDir, cfg.stateDir);
    statsLine += `  ·  本 run 完成：${rep.stats.tasks_done} 发送：${rep.stats.sends}`;
    if (rep.stats.emails.length) statsLine += `  ·  账号：${rep.stats.emails.slice(-3).join(' / ')}`;
  } catch {
    /* ignore */
  }
  lines.push(statsLine);
  lines.push('');
  lines.push('## 队列状态');
  if (!state.queue.length) {
    lines.push('（空）');
  }
  for (const t of state.queue) {
    lines.push(`- [${t.done ? 'x' : ' '}] ${t.status}${t.retries ? ` (重试${t.retries})` : ''} | ${t.text}`);
  }
  lines.push('');
  lines.push('## 最近事件');
  try {
    const evs = loadEvents(cfg.projectDir, cfg.stateDir).slice(-12).reverse();
    for (const e of evs) {
      const detail = shortDetail(e);
      lines.push(`- ${fmtTs(e['ts'])} ${e['event']}${detail ? ' | ' + detail : ''}`);
    }
  } catch {
    /* ignore */
  }
  const p = path.join(cfg.projectDir, HARNESS_STATE_FILE);
  try {
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
  } catch (e) {
    console.warn(`[warn] HARNESS_STATE.md 写入失败: ${String(e)}`);
  }
  return p;
}

// ------------------------------------------------------- checkpoint prompt ----
/** 长对话检查点：让 Agent 把当前进度固化到 HARNESS_STATE.md，作为线程变长/换号后的
 *  持久记忆。不要求追加 TODO（那是扩展路径的事）。 */
export const CHECKPOINT_PROMPT = (project: string): string =>
  `项目：${project}\n` +
  `这是一次【进度检查点】。对话已经持续了较长时间，请把当前状态固化为持久记忆，供后续轮次续接：\n` +
  `1) 在项目根目录写入/更新 HARNESS_STATE.md，内容包含：当前总体进度、最近完成的任务、` +
  `正在做/卡住的事项、下一步计划、关键文件位置与约定。控制在 40 行以内，清晰、可独立理解。\n` +
  `2) 如果发现 TODO.md 中有过时/已完成未勾选的任务，顺手修正勾选状态。\n` +
  `3) 完成后回复：检查点已更新。`;

// ---------------------------------------------------- final verify prompt ----
/** 队列空 + 两层扩展都无新任务时，让 Agent 对照 FinalGoal 做最终验收。 */
export const FINAL_VERIFY_PROMPT = (project: string, goal: string): string =>
  `项目：${project}\n` +
  `轻量规划与 FinalGoal 重规划都已确认没有新的增量任务。这是最后一次验收：\n` +
  `--- FinalGoal 开始 ---\n${goal}\n--- FinalGoal 结束 ---\n` +
  `请逐项核对 FinalGoal 的硬门槛与交付物：\n` +
  `1) 若全部达成 → 不要追加任何任务，直接回复：目标完成\n` +
  `2) 若仍有未达成项 → 在 TODO.md 末尾追加最优先的 1~3 个 ` + '`- [ ]`' + ` 任务继续推进，并简要说明还差什么\n` +
  `3) 若已无法继续推进（依赖外部/环境）→ 在 TODO.md 追加一条 ` + '`- [ ] (阻塞: 说明)`' + ` 记录阻塞，回复：存在阻塞`;
