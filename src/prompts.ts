import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from './config';
import { USER_CONFIG_DIR } from './config';
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
 *
 * 用户定制：所有提示词都可在 %APPDATA%\curloop\prompts\<key>.txt 覆盖
 * （Web「提示词」页可视化编辑保存；清空 = 恢复内置）。
 */

export const HARNESS_STATE_FILE = 'HARNESS_STATE.md';

// ------------------------------------------------------------ override ----
/** 用户提示词覆盖目录：%APPDATA%\curloop\prompts\ */
export const PROMPT_OVERRIDE_DIR = path.join(USER_CONFIG_DIR, 'prompts');

export function promptOverridePath(key: string): string {
  return path.join(PROMPT_OVERRIDE_DIR, `${key}.txt`);
}

export function promptSource(key: string): 'override' | 'builtin' {
  try {
    return fs.existsSync(promptOverridePath(key)) ? 'override' : 'builtin';
  } catch {
    return 'builtin';
  }
}

/** 加载提示词：存在覆盖文件则用文件内容，否则用内置模板。 */
export function loadPrompt(key: string, builtin: string): string {
  const p = promptOverridePath(key);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch {
    /* ignore */
  }
  return builtin;
}

// ------------------------------------------------------------ registry ----
export interface PromptDef {
  key: string;
  label: string;
  description: string;
  location: string; // 内置源位置
  placeholders: string; // 可用占位符
  template: string; // 内置模板
}

const TASK_TEMPLATE = [
  '项目：{project}',
  '请完成 TODO：{task}',
  '',
  '【工作纪律】',
  '- 先检查现状再动手：看 git 状态、最近提交与本任务相关的文件，避免重复已完成的工作。',
  '- 任务要真正完成（实现 + 验证），不要中途停；如遇到无法逾越的阻塞，在 TODO.md 中',
  '  追加一条说明阻塞的 `- [ ]` 任务并继续推进可做的部分，不要假装完成。',
  '- 每完成一个有意义的步骤就 git commit（`git add -A` + `git commit`），',
  '  commit message 简要描述该步骤，方便长跑续接时对齐进度。',
  '',
  '【续接上下文】',
  '{CONTEXT}',
  '',
  '【完成后】',
  '- 若实际进展表明还有值得继续的下一步（新问题、拆出的子任务、下一步计划），',
  '  请按 `- [ ] 任务描述` 格式追加到 TODO.md 末尾（每行一项、不重复已有任务；没有就跳过）。',
  '- 无人值守循环会读取 TODO.md 自动继续执行新任务。',
].join('\n');

const CHECKPOINT_TEMPLATE = [
  '项目：{project}',
  '这是一次【进度检查点】。对话已经持续了较长时间，请把当前状态固化为持久记忆，供后续轮次续接：',
  '1) 在项目根目录写入/更新 HARNESS_STATE.md，内容包含：当前总体进度、最近完成的任务、',
  '   正在做/卡住的事项、下一步计划、关键文件位置与约定。控制在 40 行以内，清晰、可独立理解。',
  '2) 如果发现 TODO.md 中有过时/已完成未勾选的任务，顺手修正勾选状态。',
  '3) 完成后回复：检查点已更新。',
].join('\n');

const FINAL_VERIFY_TEMPLATE = [
  '项目：{project}',
  '轻量规划与 FinalGoal 重规划都已确认没有新的增量任务。这是最后一次验收：',
  '--- FinalGoal 开始 ---',
  '{goal}',
  '--- FinalGoal 结束 ---',
  '请逐项核对 FinalGoal 的硬门槛与交付物：',
  '1) 若全部达成 → 不要追加任何任务，直接回复：目标完成',
  '2) 若仍有未达成项 → 在 TODO.md 末尾追加最优先的 1~3 个 `- [ ]` 任务继续推进，并简要说明还差什么',
  '3) 若已无法继续推进（依赖外部/环境）→ 在 TODO.md 追加一条 `- [ ] (阻塞: 说明)` 记录阻塞，回复：存在阻塞',
].join('\n');

const RESTORE_TEMPLATE = [
  '项目：{project}',
  '这是【新会话续接】。上一个会话因上下文轮转/重启已结束，请基于以下持久记忆恢复工作状态：',
  '',
  '【进度小结（HARNESS_STATE.md）】',
  '{state}',
  '',
  '【git 状态】',
  '- 最近提交：{head}',
  '- 未提交改动：{status}',
  '',
  '【最终目标（FinalGoal 前段）】',
  '{goal}',
  '',
  '【剩余 TODO 队列】',
  '{queue}',
  '',
  '请先阅读以上内容并确认理解当前状态，然后回复：已恢复上下文，可以继续。',
].join('\n');

const EXTEND_TEMPLATE = [
  '项目：{project}',
  '请分析当前项目的状态（git 状态、最近改动、TODO.md 中已完成与未完成项、未解决事项），',
  '然后在 TODO.md 文件末尾追加 1 到 3 个新的、具体可执行的 `- [ ]` 任务，持续推进项目。',
  '如果确实没有值得做的新任务，就不要追加，直接回复：无新任务。',
].join('\n');

const GOAL_EXTEND_TEMPLATE = [
  '项目：{project}',
  '轻量规划已确认没有新的增量任务。以下是本项目的最终目标（FinalGoal）：',
  '--- FinalGoal 开始 ---',
  '{goal}',
  '--- FinalGoal 结束 ---',
  '请对照 FinalGoal 逐项检查硬门槛与交付物：',
  '1) 若全部已达成（目标完成）→ 不要追加任何任务，直接回复：目标完成',
  '2) 若仍有未达成的目标 → 在 TODO.md 末尾追加 1~3 个最优先的 `- [ ]` 任务来推进，并简要回复追加情况',
  '不要重复已有 TODO 中的任务。',
].join('\n');

const PLAN_INITIAL_TEMPLATE = [
  '项目：{project}',
  '以下是本项目的最终目标（FinalGoal）：',
  '--- FinalGoal 开始 ---',
  '{goal}',
  '--- FinalGoal 结束 ---',
  '请在项目根目录创建 TODO.md：',
  '- 用 `- [ ] ` 列出当前最优先的 3~5 个具体可执行任务（涉及具体文件/路径，按优先级排序）',
  '- 任务要具体到可直接执行，不要一次列太多（后续会继续规划补充）',
  '- 直接写入 TODO.md 文件，然后回复：已完成规划',
].join('\n');

const EXPAND_GOAL_TEMPLATE = [
  '项目：{project}',
  '用户为本项目定义了以下最终目标（简短描述）：',
  '--- 用户目标 ---',
  '{goal}',
  '--- 用户目标结束 ---',
  '请基于此目标在项目根目录完成初始化规划：',
  '1) 创建 FinalGoal.md：把目标扩写为完整规划（最终目标、硬门槛/交付物、验收标准、里程碑），定位为本仓库的最高级规划。',
  '2) 创建 TODO.md：根据 FinalGoal 列出当前最优先的 3~5 个具体可执行任务（`- [ ]` 格式）。',
  '3) 完成后回复：已完成规划。',
  '若文件已存在则更新而不是覆盖。',
].join('\n');

export const PROMPT_DEFS: PromptDef[] = [
  { key: 'task', label: '任务提示词', description: '每个 TODO 任务执行时发送：工作纪律 + 续接上下文。', location: 'src/prompts.ts · buildTaskPrompt', placeholders: '{project} {task} {retries} {CONTEXT}', template: TASK_TEMPLATE },
  { key: 'extend', label: '轻量扩展', description: '队列空时让 Agent 基于当前状态追加 1~3 个新任务。', location: 'src/prompts.ts · PROMPT_DEFS', placeholders: '{project}', template: EXTEND_TEMPLATE },
  { key: 'goal_extend', label: 'FinalGoal 重规划', description: '轻量扩展无新任务时，对照 FinalGoal 重新规划。', location: 'src/prompts.ts · PROMPT_DEFS', placeholders: '{project} {goal}', template: GOAL_EXTEND_TEMPLATE },
  { key: 'plan_initial', label: '首次规划', description: 'TODO.md 缺失时，读 FinalGoal 生成初始 TODO。', location: 'src/prompts.ts · PROMPT_DEFS', placeholders: '{project} {goal}', template: PLAN_INITIAL_TEMPLATE },
  { key: 'checkpoint', label: '进度检查点', description: '每 N 个任务让 Agent 把进度小结写入 HARNESS_STATE.md。', location: 'src/prompts.ts · checkpointPrompt', placeholders: '{project}', template: CHECKPOINT_TEMPLATE },
  { key: 'final_verify', label: '最终验收', description: '队列空且扩展无新任务时，对照 FinalGoal 硬门槛做最后验收。', location: 'src/prompts.ts · finalVerifyPrompt', placeholders: '{project} {goal}', template: FINAL_VERIFY_TEMPLATE },
  { key: 'restore', label: '新会话续接', description: '线程轮转/重启后，用持久记忆在新会话恢复上下文。', location: 'src/prompts.ts · restorePrompt', placeholders: '{project} {state} {head} {status} {goal} {queue}', template: RESTORE_TEMPLATE },
  { key: 'expand_goal', label: '初始化扩写', description: '新项目引导：把用户目标扩写为完整 FinalGoal + 初始 TODO。', location: 'src/cli.ts · expandGoal', placeholders: '{project} {goal}', template: EXPAND_GOAL_TEMPLATE },
];

export function promptDef(key: string): PromptDef | undefined {
  return PROMPT_DEFS.find((d) => d.key === key);
}

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
/** 自定义任务提示词文件（旧机制，prompt.task_prompt_file）：存在时完全使用文件内容。 */
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

/** 构建「续接上下文」块（git 状态 / HARNESS_STATE.md 摘要）。 */
function buildContextBlock(cfg: Config): string {
  if (!cfg.prompt.taskContext) return '';
  const ctx = readTaskContext(cfg.projectDir);
  const lines: string[] = [];
  if (ctx.head) lines.push(`- 最近提交：${ctx.head}`);
  if (ctx.status) lines.push(`- 未提交改动：\n${ctx.status.slice(0, 800)}`);
  if (ctx.stateFile) {
    lines.push(`- HARNESS_STATE.md（之前轮次的进度小结，先读它再继续）：\n${ctx.stateFile}`);
  } else {
    lines.push(`- 尚无 HARNESS_STATE.md。`);
  }
  return lines.join('\n');
}

/** 任务提示词 v2：任务本体 + 工作纪律 + 可续接上下文（支持文件/注册表覆盖）。 */
export function buildTaskPrompt(cfg: Config, task: TodoTask): string {
  const overrideFile = taskPromptOverride(cfg);
  let p = overrideFile !== null ? overrideFile : loadPrompt('task', TASK_TEMPLATE);
  const contextBlock = buildContextBlock(cfg);
  if (p.includes('{CONTEXT}')) {
    p = p.replace('{CONTEXT}', contextBlock);
  } else if (contextBlock) {
    p += `\n${contextBlock}`;
  }
  p = p
    .replaceAll('{project}', cfg.projectDir)
    .replaceAll('{task}', task.text)
    .replaceAll('{retries}', String(task.retries));
  if (cfg.prompt.goalInTask) {
    const goal = readFinalGoalExcerpt(cfg.projectDir);
    if (goal) p += `\n\n【目标提示】项目最终目标（FinalGoal）要点，别忘了对齐：\n${goal}`;
  }
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
  let p = loadPrompt('restore', RESTORE_TEMPLATE);
  p = p
    .replaceAll('{project}', cfg.projectDir)
    .replaceAll('{state}', ctx.stateFile || '（尚无 HARNESS_STATE.md）')
    .replaceAll('{head}', ctx.head || '(无提交)')
    .replaceAll('{status}', ctx.status || '（工作区干净）')
    .replaceAll('{goal}', readFinalGoalExcerpt(cfg.projectDir) || '（无 FinalGoal.md）')
    .replaceAll('{queue}', queueSummary || '（空）');
  return p;
}

// ----------------------------------------------------- checkpoint / verify ----
/** 长对话检查点：让 Agent 把当前进度固化到 HARNESS_STATE.md。 */
export function checkpointPrompt(project: string): string {
  return loadPrompt('checkpoint', CHECKPOINT_TEMPLATE).replaceAll('{project}', project);
}
/** 兼容旧名。 */
export const CHECKPOINT_PROMPT = checkpointPrompt;

/** 队列空 + 两层扩展都无新任务时，让 Agent 对照 FinalGoal 做最终验收。 */
export function finalVerifyPrompt(project: string, goal: string): string {
  return loadPrompt('final_verify', FINAL_VERIFY_TEMPLATE)
    .replaceAll('{project}', project)
    .replaceAll('{goal}', goal);
}
/** 兼容旧名。 */
export const FINAL_VERIFY_PROMPT = finalVerifyPrompt;

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

// -------------------------------------------------------- extend / plan ----
/** 轻量扩展 / FinalGoal 重规划 / 首次规划 / 初始化扩写 的加载器（注册表覆盖）。 */
export function extendPrompt(project: string): string {
  return loadPrompt('extend', EXTEND_TEMPLATE).replaceAll('{project}', project);
}
export function goalExtendPrompt(project: string, goal: string): string {
  return loadPrompt('goal_extend', GOAL_EXTEND_TEMPLATE)
    .replaceAll('{project}', project)
    .replaceAll('{goal}', goal);
}
export function planInitialPrompt(project: string, goal: string): string {
  return loadPrompt('plan_initial', PLAN_INITIAL_TEMPLATE)
    .replaceAll('{project}', project)
    .replaceAll('{goal}', goal);
}
export function expandGoalPrompt(project: string, goal: string): string {
  return loadPrompt('expand_goal', EXPAND_GOAL_TEMPLATE)
    .replaceAll('{project}', project)
    .replaceAll('{goal}', goal);
}
