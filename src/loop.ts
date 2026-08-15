import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Config, load as loadConfig, setProjectOverride, validate } from './config';
import * as cursor from './cursor';
import { buildStatus } from './observer';
import * as ui from './ui';
import { CompletionTracker, REPLY_JS, buildLimitJs, buildLogoutJs } from './detection';
import { RefreshReport, refreshAccount } from './loginAssistant';
import { RunState } from './runState';
import { TodoTask, ensureDone, parseAll } from './todoQueue';
import { sleep } from './cdp';
import {
  buildTaskPrompt,
  CHECKPOINT_PROMPT,
  FINAL_VERIFY_PROMPT,
} from './prompts';

/** 无人值守 Cursor 编码循环 — state machine + CLI。
 *
 * 用法（node dist/loop.js … 或 curloop --check-config …）：
 *   curloop --check-config
 *   curloop --dry-run
 *   curloop --mode live --project D:\\2026AppDev\\RAGLab
 *   curloop --mode limit-sim
 *   curloop --max-tasks 10 --max-switches 3 --mode live --project <dir>
 */

// ------------------------------------------------------------- interrupt ----
/** Ctrl-C 请求中断：让所有轮询 sleep 立即返回，而不是等下一个轮询周期。
 *  Python 版在 time.sleep 里直接抛 KeyboardInterrupt；Node 必须自己实现。 */
class HarnessInterrupt extends Error {
  constructor() {
    super('interrupt requested');
    this.name = 'HarnessInterrupt';
  }
}

let interruptRequested = false;
const interruptWaiters: Array<() => void> = [];

export function requestInterrupt(): void {
  interruptRequested = true;
  const ws = interruptWaiters.splice(0);
  for (const w of ws) w();
}

/** 可中断 sleep：Ctrl-C 时提前返回（调用方随后检查 interruptRequested 抛 HarnessInterrupt）。 */
export async function sleepInterruptible(seconds: number): Promise<void> {
  if (interruptRequested) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      const i = interruptWaiters.indexOf(w);
      if (i >= 0) interruptWaiters.splice(i, 1);
      resolve();
    }, seconds * 1000);
    const w = (): void => {
      clearTimeout(timer);
      resolve();
    };
    interruptWaiters.push(w);
  });
}

function checkInterrupt(): void {
  if (interruptRequested) throw new HarnessInterrupt();
}

// ------------------------------------------------------------- stop file ----
/** STOP 文件路径：config.control.stop_file 或 <projectDir>/STOP。存在即优雅中止。 */
export function stopFilePath(cfg: Config): string {
  return cfg.control.stopFile
    ? (path.isAbsolute(cfg.control.stopFile)
        ? cfg.control.stopFile
        : path.join(cfg.projectDir, cfg.control.stopFile))
    : path.join(cfg.projectDir, 'STOP');
}

function checkStopFile(cfg: Config): void {
  if (fs.existsSync(stopFilePath(cfg))) {
    throw new StopRequested();
  }
}

class StopRequested extends Error {
  constructor() {
    super('stop file present');
    this.name = 'StopRequested';
  }
}

// ------------------------------------------------------------------- CLIs ----
export function cmdCheckConfig(cfg: Config): number {
  const problems = validate(cfg);
  for (const p of problems) console.log('[!]', p);
  if (problems.length) {
    console.log('[fail] 配置有问题');
    return 1;
  }
  console.log('[ok] config paths OK');
  console.log('  project_dir :', cfg.projectDir, '(exists:', fs.existsSync(cfg.projectDir), ')');
  console.log('  todo_file   :', cfg.todoFile, '(exists:', fs.existsSync(cfg.todoFile), ')');
  console.log('  cursor.exe  :', cfg.cursor.exe);
  console.log('  cursor.prof :', cfg.cursor.profile);
  console.log('  assistant   :', cfg.loginAssistant.exe);
  const auth = cursor.authInfo(cfg);
  console.log('  auth        :', {
    dbExists: auth.dbExists,
    hasAccessToken: auth.hasAccessToken,
    email: auth.email,
    accessFp: auth.accessFp,
  });
  return 0;
}

export async function cmdDryRun(cfg: Config): Promise<number> {
  const tasks = parseAll(cfg.todoFile);
  const pending = tasks.filter((t) => !t.done);
  console.log(`TODO.md: ${tasks.length} 项，待办 ${pending.length} 项`);
  for (const t of pending) {
    console.log(`  [${t.index}] (L${t.line}) ${t.text}`);
  }
  console.log('cdp up      :', await cursor.cdpUp(cfg.cursor.port));
  console.log('cdp version :', await cursor.cdpVersion(cfg.cursor.port));
  console.log('auth fp     :', cursor.authFp(cfg));
  console.log(
    'templates   : refresh=',
    Boolean(cfg.loginAssistant.refreshTemplate && fs.existsSync(cfg.loginAssistant.refreshTemplate)),
    ' confirm=',
    Boolean(cfg.loginAssistant.confirmTemplate && fs.existsSync(cfg.loginAssistant.confirmTemplate)),
  );
  return 0;
}

export async function cmdAssistantDryRun(cfg: Config): Promise<number> {
  console.log('[assistant-dry-run] 只定位，不点击、不启动新进程（除非已在运行）');
  const rep = await refreshAccount(cfg, true);
  console.log(JSON.stringify(rep, null, 2));
  const windowOk = (rep.steps || []).some((s) => s['step'] === 'window' && s['ok']);
  const refreshOk = (rep.steps || []).some((s) => s['step'] === 'refresh' && s['ok']);
  console.log('[assistant-dry-run] window_ok=', windowOk, ' refresh_template_found=', refreshOk);
  return windowOk ? 0 : 1;
}

export async function cmdDetectOnly(cfg: Config, seconds: number): Promise<number> {
  cursor.init(cfg);
  if (!(await cursor.cdpUp(cfg.cursor.port))) {
    console.log('CDP 未就绪（Cursor 未带调试端口运行），先启动再 --detect-only');
    return 1;
  }
  const tracker = new CompletionTracker(
    cfg.timeouts.completionStablePolls,
    cfg.timeouts.minElapsedBeforeCompleteS,
    cfg.timeouts.replyMaxS,
  );
  let prev = new Set<string>();
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const r = await cursor.pollReply(cfg, tracker, prev);
    const limitSample = (r['limitSample'] as Record<string, unknown>) || {};
    const logout = (r['logout'] as Record<string, unknown>) || {};
    const reply = (r['reply'] as Record<string, unknown>) || {};
    prev = new Set<string>((limitSample['hits'] as string[]) || []);
    console.log(
      `state=${r['state']} detail=${JSON.stringify(r['detail'] ?? '')} ` +
        `hits=${JSON.stringify([...prev].sort())} hard=${limitSample['hard']} ` +
        `loggedOut=${logout['loggedOut']} ` +
        `busy=${reply['busy']} pairCount=${reply['pairCount']}`,
    );
    await sleep(cfg.timeouts.completionPollIntervalS);
  }
  return 0;
}

export async function cmdAssistantRefreshOnly(cfg: Config): Promise<number> {
  /** Verification: kill Cursor, click 刷新Cursor, confirm, wait for token flip. */
  cursor.init(cfg);
  const old = cursor.authFp(cfg);
  console.log('[refresh-only] 旧 token fp:', old);
  await cursor.killAllCursor();
  const rep = await refreshAccount(cfg, false);
  console.log(JSON.stringify(rep, null, 2));
  const [okChange, info] = await cursor.waitTokenChange(cfg, old, cfg.timeouts.switchTokenTimeoutS);
  console.log('[refresh-only] token 变化:', okChange, '->', info['accessFp'], info['email']);
  return okChange ? 0 : 1;
}

export async function cmdInjectLimitNode(cfg: Config): Promise<number> {
  cursor.init(cfg);
  if (!(await cursor.cdpUp(cfg.cursor.port))) {
    console.log('CDP 未就绪');
    return 1;
  }
  console.log(await cursor.injectLimitNode(cfg.cursor.port));
  return 0;
}

// ------------------------------------------------------------------ helpers ----
function canSwitch(cfg: Config, state: RunState): boolean {
  const m = cfg.retry.maxTotalAccountSwitchesPerRun;
  return m <= 0 || state.switchesUsed < m; // <=0 = 不限次数（默认）
}

function skip(state: RunState, task: TodoTask, reason: string): string {
  task.status = 'skipped';
  task.switchReason = reason;
  state.log('task_skipped', { task: task.text.slice(0, 60), reason });
  return 'skipped';
}

/** 精简换号助手报告，避免整包 steps/标题列表撑爆 events.jsonl。 */
function switchReportSummary(rep: RefreshReport): Record<string, unknown> {
  const stepsOut: Record<string, unknown>[] = [];
  for (const s of rep.steps || []) {
    const slim: Record<string, unknown> = {};
    for (const k of ['step', 'ok', 'reason', 'error'] as const) {
      if (s[k] !== undefined) slim[k] = s[k];
    }
    stepsOut.push(slim);
  }
  const out: Record<string, unknown> = { ok: rep.ok, steps: stepsOut };
  if (rep.error) out['error'] = rep.error;
  return out;
}

async function doSwitch(cfg: Config, state: RunState, task: TodoTask): Promise<boolean> {
  const old = cursor.authFp(cfg);
  state.log('switch_start', { task: task.text.slice(0, 40), old_fp: old });
  await cursor.killAllCursor();
  const rep = await refreshAccount(cfg, false);
  state.log('switch_click', { report: JSON.stringify(switchReportSummary(rep)) });
  const [okChange, info] = await cursor.waitTokenChange(cfg, old, cfg.timeouts.switchTokenTimeoutS);
  state.switchesUsed += 1;
  state.save();
  if (!okChange) {
    state.log('switch_failed', { reason: 'token 未变化' });
    return false;
  }
  state.log('switch_ok', { new_fp: info['accessFp'], email: info['email'] });
  const cd = cfg.retry.cooldownBetweenSwitchesS;
  if (cd) {
    state.log('cooldown', { seconds: cd });
    await sleepInterruptible(cd);
    checkInterrupt();
  }
  return true;
}

/** Ensure a logged-in Cursor with CDP. Returns 'ok' | 'switch' | 'failed'. */
async function ensureReady(cfg: Config, state: RunState, task: TodoTask): Promise<string> {
  if (!cursor.authFp(cfg)) {
    state.log('no_auth', { task: task.text.slice(0, 40) });
    return 'switch';
  }
  const res = await cursor.ensureReady(cfg, cfg.projectDir, true);
  if (res['ok']) return 'ok';
  state.log('ensure_failed', { errors: res['errors'] });
  return 'failed';
}

// 周期状态块计时（单线程 loop，模块级足够）：距上次 >= periodic 时打印。
let lastStatusTs = 0.0;

function maybePrintStatus(cfg: Config): void {
  const periodic = cfg.ui.periodicStatusS;
  if (periodic <= 0) return;
  const now = Date.now();
  if (now - lastStatusTs < periodic * 1000) return;
  lastStatusTs = now;
  try {
    console.log(ui.statusRender(buildStatus(cfg.projectDir, cfg.stateDir)));
    console.log();
  } catch {
    /* 状态面板异常不影响主循环 */
  }
}

/** Wait (up to timeout) until Cursor reports idle before sending the next prompt.
 *  Returns "ok" | "limit" | "logged_out"（等待期间页面出现 usage limit / 登出）。 */
async function ensureIdleBeforeSend(
  cfg: Config,
  state: RunState | null = null,
  timeoutS = 1800.0,
): Promise<string> {
  const deadline = Date.now() + timeoutS * 1000;
  let waited = 0.0;
  while (Date.now() < deadline) {
    maybePrintStatus(cfg); // 长等待期间也刷新周期状态块
    let flags: string[] = [];
    try {
      const s = (await cursor.evaluateJs(cfg.cursor.port, REPLY_JS)) || {};
      if (!s['busy']) return 'ok';
      flags = (['hasStop', 'thinking', 'toolActivity', 'toolRunning', 'toolWaiting', 'hasQueued', 'composerText'] as const)
        .filter((k) => s[k]);
    } catch {
      return 'ok'; // CDP trouble — don't block the run
    }
    // 空闲门禁期间每 30s：记事件 + 清弹窗 + 检测 limit/logged_out
    if (waited >= 30.0) {
      waited = 0.0;
      try {
        const ls = (await cursor.evaluateJs(cfg.cursor.port, buildLimitJs(cfg.detection))) || {};
        const hits = (ls['hits'] as string[]) || [];
        // idle 门禁内放宽为 hits 非空：busy 等待 + limit 关键词几乎必是真 limit
        if (hits.length) {
          if (state) state.log('idle_limit', { hits, busy: true, flags });
          return 'limit';
        }
        const lo = (await cursor.evaluateJs(cfg.cursor.port, buildLogoutJs(cfg.detection))) || {};
        if (lo['loggedOut']) return 'logged_out';
      } catch {
        /* ignore */
      }
      if (state) state.log('idle_wait', { busy: true, flags, detail: 'awaiting idle before send' });
      // Agent 空闲但 composer 残留文本（唯一 busy 信号）→ 清空解除卡死
      if (flags.length === 1 && flags[0] === 'composerText') {
        const cleared = await cursor.clearComposer(cfg);
        if (state && cleared['ok']) state.log('composer_cleared', { reason: 'leftover composer text, agent idle' });
      }
      try {
        await cursor.dismissAll(cfg.cursor.port);
      } catch {
        /* ignore */
      }
    }
    await sleepInterruptible(5);
    checkInterrupt();
    checkStopFile(cfg);
    waited += 5.0;
  }
  return 'ok'; // 超时：按原语义放行，避免死锁
}

async function send(cfg: Config, state: RunState, task: TodoTask, prompt: string): Promise<boolean> {
  if (task.retries) {
    prompt = `${prompt}\n[这是第 ${task.retries + 1} 次尝试，请继续完成；之前可能被中断]`;
  }
  for (let attempt = 0; attempt <= cfg.retry.sendRetries; attempt++) {
    if ((await ensureIdleBeforeSend(cfg, state)) !== 'ok') return false; // limit/logged_out → 让 runTask 换号
    const sr = await cursor.sendPrompt(cfg, prompt);
    if (sr['ok']) {
      state.log('sent', { task: task.text.slice(0, 40), attempt });
      return true;
    }
    const type = (sr['type'] as Record<string, unknown>) || {};
    const reason = type['reason'] || sr['error'] || 'unknown';
    state.log('send_failed', { attempt, reason: String(reason) });
    await sleep(2);
  }
  return false;
}

const EXTEND_PROMPT =
  '项目：{project}\n' +
  '请分析当前项目的状态（git 状态、最近改动、TODO.md 中已完成与未完成项、未解决事项），\n' +
  '然后在 TODO.md 文件末尾追加 1 到 3 个新的、具体可执行的 `- [ ]` 任务，持续推进项目。\n' +
  '如果确实没有值得做的新任务，就不要追加，直接回复：无新任务。';

const GOAL_EXTEND_PROMPT =
  '项目：{project}\n' +
  '轻量规划已确认没有新的增量任务。以下是本项目的最终目标（FinalGoal）：\n' +
  '--- FinalGoal 开始 ---\n{goal}\n--- FinalGoal 结束 ---\n' +
  '请对照 FinalGoal 逐项检查硬门槛与交付物：\n' +
  '1) 若全部已达成（目标完成）→ 不要追加任何任务，直接回复：目标完成\n' +
  '2) 若仍有未达成的目标 → 在 TODO.md 末尾追加 1~3 个最优先的 `- [ ]` 任务来推进，并简要回复追加情况\n' +
  '不要重复已有 TODO 中的任务。';

const INITIAL_PLAN_PROMPT =
  '项目：{project}\n' +
  '以下是本项目的最终目标（FinalGoal）：\n' +
  '--- FinalGoal 开始 ---\n{goal}\n--- FinalGoal 结束 ---\n' +
  '请在项目根目录创建 TODO.md：\n' +
  '- 用 `- [ ] ` 列出当前最优先的 3~5 个具体可执行任务（涉及具体文件/路径，按优先级排序）\n' +
  '- 任务要具体到可直接执行，不要一次列太多（后续会继续规划补充）\n' +
  '- 直接写入 TODO.md 文件，然后回复：已完成规划';

const GOAL_CHUNK = 6000; // FinalGoal 可能很长；规划时只带前段（验收标准/硬门槛通常在前）

function readFinalGoal(cfg: Config): string {
  try {
    return fs.readFileSync(cfg.finalGoalFilePath, 'utf-8');
  } catch {
    return '';
  }
}

/** ensure_ready -> send -> wait for the agent to finish.
 *  Returns "ok" | "switch" | "failed"。 */
export async function sendAndWait(
  cfg: Config,
  state: RunState,
  prompt: string,
  eventPrefix = 'extend',
): Promise<string> {
  state.log(`${eventPrefix}_start`, { project: cfg.projectDir });
  const er = await cursor.ensureReady(cfg, cfg.projectDir, true);
  if (!er['ok']) {
    state.log(`${eventPrefix}_failed`, { reason: String(er['errors'] ?? 'not ready') });
    return 'failed';
  }
  const gate = await ensureIdleBeforeSend(cfg, state); // don't queue the plan prompt while busy
  if (gate === 'limit' || gate === 'logged_out') {
    state.log(`${eventPrefix}_failed`, { reason: gate });
    return 'switch'; // 可恢复：extendOrSwitch 会换号后重试
  }
  const sr = await cursor.sendPrompt(cfg, prompt, true);
  if (!sr['ok']) {
    const type = (sr['type'] as Record<string, unknown>) || {};
    const reason = sr['error'] || type['reason'] || 'send failed';
    state.log(`${eventPrefix}_failed`, { reason: String(reason) });
    return 'failed';
  }
  state.log(`${eventPrefix}_sent`);
  const tracker = new CompletionTracker(
    cfg.timeouts.completionStablePolls,
    cfg.timeouts.minElapsedBeforeCompleteS,
    cfg.timeouts.replyMaxS,
  );
  let prev = new Set<string>();
  const interval = cfg.timeouts.completionPollIntervalS;
  while (true) {
    await sleepInterruptible(interval);
    checkInterrupt();
    checkStopFile(cfg);
    maybePrintStatus(cfg); // 扩展/规划等待期间也刷新周期状态块
    const r = await cursor.pollReply(cfg, tracker, prev);
    const st = r['state'];
    if (st === 'done') return 'ok';
    if (st === 'limit' || st === 'logged_out') {
      state.log(`${eventPrefix}_failed`, { reason: st });
      return 'switch'; // 可恢复：调用方换号后重试
    }
    if (st === 'no_page' || st === 'cdp_error' || st === 'hard_timeout') {
      state.log(`${eventPrefix}_failed`, { reason: st });
      return 'failed';
    }
    // busy / waiting：Agent 正在生成，继续等（CompletionTracker 负责最终判定）
  }
}

/** 扩展/规划等待：撞 limit/logged_out 时换号后重试，而不是当作"无新任务"放弃。 */
async function extendOrSwitch(
  cfg: Config,
  state: RunState,
  prompt: string,
  eventPrefix: string,
): Promise<boolean> {
  for (let attempt = 0; attempt <= cfg.retry.sendRetries; attempt++) {
    const r = await sendAndWait(cfg, state, prompt, eventPrefix);
    if (r === 'ok') return true;
    if (r !== 'switch') return false;
    if (!canSwitch(cfg, state)) {
      state.log(`${eventPrefix}_failed`, { reason: 'switch budget exhausted' });
      return false;
    }
    // 扩展/规划路径没有真实任务，用占位 TodoTask 记录本次换号用途
    const dummy = new TodoTask({ text: `${eventPrefix} (queue empty)`, line: 0 });
    if (!(await doSwitch(cfg, state, dummy))) {
      state.log(`${eventPrefix}_failed`, { reason: 'switch_failed' });
      return false;
    }
    state.log(`${eventPrefix}_switch_retry`, { attempt: attempt + 1 });
  }
  state.log(`${eventPrefix}_failed`, { reason: 'send retries exhausted' });
  return false;
}

/** Reload the queue from TODO.md; return the fresh state if new tasks appeared. */
function reloadQueue(cfg: Config, state: RunState, eventPrefix: string): RunState | null {
  const fresh = RunState.load(cfg.snapshotFile, cfg.eventLogFile, cfg.todoFile);
  const newTasks = fresh.queue.filter((t) => t.status === 'pending' || t.status === 'running').length;
  state.log(`${eventPrefix}_result`, { new_tasks: newTasks });
  return newTasks > 0 ? fresh : null;
}

/** Level-1 light auto-extend: plan from the current TODO/project state only. */
async function tryExtendTasks(cfg: Config, state: RunState): Promise<RunState | null> {
  if (!(await extendOrSwitch(cfg, state, EXTEND_PROMPT.replace('{project}', cfg.projectDir), 'extend'))) {
    return null;
  }
  return reloadQueue(cfg, state, 'extend');
}

/** Level-2: light extend found nothing -> re-read FinalGoal and re-plan. */
async function tryGoalExtend(cfg: Config, state: RunState): Promise<RunState | null> {
  const goal = readFinalGoal(cfg);
  if (!goal) {
    state.log('goal_extend_failed', { reason: 'FinalGoal not found' });
    return null;
  }
  const prompt = GOAL_EXTEND_PROMPT.replace('{project}', cfg.projectDir).replace('{goal}', goal.slice(0, GOAL_CHUNK));
  if (!(await extendOrSwitch(cfg, state, prompt, 'goal_extend'))) return null;
  return reloadQueue(cfg, state, 'goal_extend');
}

/** TODO.md missing: read FinalGoal and ask the agent to create the initial plan. */
export async function planInitialTodo(cfg: Config, state: RunState): Promise<RunState | null> {
  const goal = readFinalGoal(cfg);
  if (!goal) {
    state.log('plan_todo_failed', { reason: 'FinalGoal not found' });
    return null;
  }
  const prompt = INITIAL_PLAN_PROMPT.replace('{project}', cfg.projectDir).replace('{goal}', goal.slice(0, GOAL_CHUNK));
  if (!(await extendOrSwitch(cfg, state, prompt, 'plan_todo'))) return null;
  return reloadQueue(cfg, state, 'plan_todo');
}

/** Best-effort commit after a finished task (the prompt also asks the agent). */
function gitCommit(cfg: Config, task: TodoTask): void {
  if (!cfg.gitCommitAfterTask) return;
  try {
    const msg = `task: ${task.text.slice(0, 60)}`;
    cp.spawnSync('git', ['add', '-A'], { cwd: cfg.projectDir, stdio: 'ignore' });
    cp.spawnSync('git', ['commit', '-m', msg], { cwd: cfg.projectDir, stdio: 'ignore' });
  } catch {
    /* not a git repo, no changes, etc. */
  }
}

/** True when the 'last message' is actually the prompt we sent (composer echo). */
function isPromptEcho(promptNorm: string, lastFull: string): boolean {
  if (!promptNorm || !lastFull) return false;
  const n = lastFull.replace(/\s+/g, ' ').trim().toLowerCase();
  const p = promptNorm.toLowerCase();
  if (!n) return false;
  if (n === p) return true;
  // Truncated echo: last message is a long prefix of the prompt.
  if (n.length >= 20 && p.length >= 20 && p.startsWith(n) && n.length >= p.length * 0.6) return true;
  return false;
}

/** Poll until done / relaunch / switch. Returns (outcome, detail). */
async function waitReply(
  cfg: Config,
  state: RunState,
  task: TodoTask,
  sim: { forced: boolean },
  prompt: string,
): Promise<[string, string]> {
  const tracker = new CompletionTracker(
    cfg.timeouts.completionStablePolls,
    cfg.timeouts.minElapsedBeforeCompleteS,
    cfg.timeouts.replyMaxS,
  );
  const promptNorm = prompt.replace(/\s+/g, ' ').trim();
  let prev = new Set<string>();
  const interval = cfg.timeouts.completionPollIntervalS;
  state.log('wait_reply', { task: task.text.slice(0, 60) });
  let pollCount = 0;
  let lastPollKey: string | null = null; // 仅状态变化时落盘 poll，避免长跑刷爆 jsonl

  const logPollIfChanged = (st: string, detail: string, r: Record<string, unknown>): void => {
    const limitSample = (r['limitSample'] as Record<string, unknown>) || {};
    const logout = (r['logout'] as Record<string, unknown>) || {};
    const reply = (r['reply'] as Record<string, unknown>) || {};
    const key = JSON.stringify([
      st,
      Boolean(limitSample['hard']),
      Boolean(logout['loggedOut']),
      Boolean(reply['busy']),
      reply['pairCount'],
      detail.slice(0, 80),
    ]);
    if (key === lastPollKey) return;
    lastPollKey = key;
    state.log('poll', {
      state: st,
      detail,
      hits: [...prev].sort(),
      hard: limitSample['hard'],
      loggedOut: logout['loggedOut'],
      busy: reply['busy'],
      pairCount: reply['pairCount'],
    });
  };

  while (true) {
    await sleepInterruptible(interval);
    checkInterrupt();
    checkStopFile(cfg);
    pollCount += 1;
    maybePrintStatus(cfg); // 长等待（等回复）期间也刷新周期状态块
    // Promo/update modals can pop up mid-conversation; dismiss periodically
    if (pollCount % 3 === 0) {
      try {
        await cursor.dismissAll(cfg.cursor.port);
      } catch {
        /* ignore */
      }
    }
    const r = await cursor.pollReply(cfg, tracker, prev);
    const limitSample = (r['limitSample'] as Record<string, unknown>) || {};
    prev = new Set<string>((limitSample['hits'] as string[]) || []);
    let st = r['state'] as string;
    let detail = (r['detail'] as string) || '';
    if (cfg.mode === 'limit-sim' && !sim.forced && (st === 'waiting' || st === 'busy')) {
      st = 'limit';
      detail = 'limit-sim forced (once)';
      sim.forced = true;
    }
    logPollIfChanged(st, detail, r);
    if (st === 'done') {
      const reply = (r['reply'] as Record<string, unknown>) || {};
      if (isPromptEcho(promptNorm, String(reply['lastFull'] ?? ''))) {
        tracker.disqualify();
        logPollIfChanged('waiting', 'prompt echo, still waiting', r);
        continue;
      }
      // Confirm silence: one more poll to make sure the agent is really idle
      await sleepInterruptible(interval);
      checkInterrupt();
      checkStopFile(cfg);
      const r2 = await cursor.pollReply(cfg, tracker, prev);
      if (r2['state'] === 'done') return ['done', detail];
      logPollIfChanged(String(r2['state']), (r2['detail'] as string) || '', r2);
      continue;
    }
    if (st === 'limit' || st === 'logged_out') return ['switch', detail];
    if (st === 'no_page' || st === 'cdp_error') {
      if (task.retries < cfg.retry.hangRetriesPerTask) return ['relaunch', detail];
      return ['switch', detail];
    }
    if (st === 'hard_timeout') {
      if (task.retries < cfg.retry.hangRetriesPerTask) return ['relaunch', detail];
      return ['switch', detail];
    }
  }
}

// -------------------------------------------------------------------- task ----
export async function runTask(cfg: Config, state: RunState, task: TodoTask, sim: { forced: boolean }): Promise<string> {
  const prompt = buildTaskPrompt(cfg, task);
  state.log('task_start', { task: task.text.slice(0, 60), line: task.line, retries: task.retries });
  while (true) {
    const ready = await ensureReady(cfg, state, task);
    if (ready === 'switch' || ready === 'failed') {
      if (!canSwitch(cfg, state)) return skip(state, task, `ensure:${ready}`);
      task.retries += 1;
      if (!(await doSwitch(cfg, state, task))) return skip(state, task, 'switch_failed');
      continue;
    }

    if (!(await send(cfg, state, task, prompt))) {
      if (!canSwitch(cfg, state)) return skip(state, task, 'send_failed');
      task.retries += 1;
      if (!(await doSwitch(cfg, state, task))) return skip(state, task, 'switch_failed');
      continue;
    }

    const [outcome, detail] = await waitReply(cfg, state, task, sim, prompt);
    if (outcome === 'done') {
      const result = ensureDone(cfg.todoFile, task.text);
      if (result === 'missing') {
        console.log(`[warn] TODO 无匹配行，已追加 [x] 防重跑: ${task.text.slice(0, 60)}`);
      }
      task.status = 'done';
      task.done = true;
      state.log('task_done', { task: task.text.slice(0, 60), detail, todo_mark: result });
      // 先落盘：reloadQueue 从磁盘 snapshot 合并，否则 mark 失败时会重跑。
      state.save();
      return 'done';
    }
    if (outcome === 'relaunch') {
      task.retries += 1;
      state.log('relaunch_retry', { task: task.text.slice(0, 60), detail });
      await cursor.killAllCursor();
      continue;
    }
    // limit / logged_out / hard_timeout / switch
    if (!canSwitch(cfg, state)) return skip(state, task, `${outcome}:${detail} (no switch budget)`);
    task.retries += 1;
    state.log('switch_trigger', { task: task.text.slice(0, 60), reason: outcome, detail });
    if (!(await doSwitch(cfg, state, task))) return skip(state, task, 'switch_failed');
  }
}

// -------------------------------------------------------------------- main ----
/** Level-3 最终验收：两层扩展都无新任务时，让 Agent 对照 FinalGoal 确认目标是否真完成。 */
async function tryFinalVerify(cfg: Config, state: RunState): Promise<RunState | null> {
  const goal = readFinalGoal(cfg);
  if (!goal) {
    state.log('final_verify_failed', { reason: 'FinalGoal not found' });
    return null;
  }
  if (
    !(await extendOrSwitch(
      cfg,
      state,
      FINAL_VERIFY_PROMPT(cfg.projectDir, goal.slice(0, GOAL_CHUNK)),
      'final_verify',
    ))
  ) {
    return null;
  }
  return reloadQueue(cfg, state, 'final_verify');
}

/** 运行结束报告：runstate/<key>/report.json + 控制台摘要。 */
function writeFinalReport(cfg: Config, state: RunState, kind: string): void {
  try {
    const rep = buildStatus(cfg.projectDir, cfg.stateDir);
    const report = {
      project: cfg.projectDir,
      mode: cfg.mode,
      end_kind: kind,
      ended_at: new Date().toISOString(),
      stats: rep.stats,
      queue: state.queue.map((t) => ({
        text: t.text,
        status: t.status,
        retries: t.retries,
        switch_reason: t.switchReason,
      })),
      switches_used: state.switchesUsed,
    };
    fs.mkdirSync(cfg.projectStateDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.projectStateDir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
    console.log(
      `[report] ${kind}: 完成=${rep.stats.tasks_done} 发送=${rep.stats.sends} ` +
        `换号=${rep.stats.switches}(成功${rep.stats.switch_ok}/失败${rep.stats.switch_failed}) ` +
        `剩余队列=${state.queue.length}`,
    );
  } catch (e) {
    console.log(`[warn] 结束报告写入失败: ${String(e)}`);
  }
}

export async function run(cfg: Config): Promise<number> {
  cursor.init(cfg);
  let state = RunState.load(cfg.snapshotFile, cfg.eventLogFile, cfg.todoFile);
  state.log('run_start', {
    mode: cfg.mode,
    project: cfg.projectDir,
    profile: cfg.cursor.profile,
    todo: cfg.todoFile,
  });
  const sim: { forced: boolean } = { forced: false }; // limit-sim: force the switch once
  let extendUsed = 0; // level-1 light auto-extend refills
  let goalExtendUsed = 0; // level-2 FinalGoal re-plans
  let tasksDoneInRun = 0; // 单次 run 完成任务计数（max_tasks 预算）
  state.switchesUsed = 0; // 每次 run 独立换号预算（不跨 run 累计）
  ui.init();

  const onSigint = () => requestInterrupt();
  process.once('SIGINT', onSigint);
  try {
    while (true) {
      if (interruptRequested) {
        state.log('interrupt');
        state.save();
        console.log('\n[interrupt] 状态已保存，可再次运行续跑');
        return 130;
      }
      checkStopFile(cfg);
      maybePrintStatus(cfg); // 周期状态块（waitReply/ensureIdle 内也会调用）
      const task = state.nextTask();
      if (task === null) {
        // Queue empty. TODO.md missing (first run / deleted) -> always re-read
        // FinalGoal and regenerate the plan, never light-extend.
        let fresh: RunState | null = null;
        if (!fs.existsSync(cfg.todoFile) && cfg.autoPlanTodo) {
          fresh = await planInitialTodo(cfg, state);
        }
        // Level 1: light auto-extend from current TODO state.
        if (fresh === null && cfg.retry.autoExtend && extendUsed < cfg.retry.autoExtendMaxIterations) {
          fresh = await tryExtendTasks(cfg, state);
          if (fresh !== null) extendUsed += 1;
        }
        // Level 2: only if light planning really found nothing, re-read FinalGoal.
        if (fresh === null && cfg.retry.autoExtend && goalExtendUsed < cfg.retry.autoExtendMaxIterations) {
          fresh = await tryGoalExtend(cfg, state);
          if (fresh !== null) goalExtendUsed += 1;
        }
        // Level 3: final verification against FinalGoal (opt-in, prompt.final_verify)
        if (fresh === null && cfg.prompt.finalVerify) {
          fresh = await tryFinalVerify(cfg, state);
        }
        if (fresh !== null) {
          // Adopt the freshly planned queue — our own state is still empty.
          state = fresh;
          state.save();
          continue;
        }
        // Otherwise leave the UI usable — best-effort dismiss any modal
        try {
          if (await cursor.cdpUp(cfg.cursor.port)) {
            await cursor.dismissUntilClear(cfg.cursor.port, 15.0, 2.0);
          }
        } catch {
          /* ignore */
        }
        state.log('run_done', { pending: 0, tasks_done: tasksDoneInRun });
        writeFinalReport(cfg, state, 'run_done');
        console.log(
          JSON.stringify({
            run_done: true,
            queue: state.queue.length,
            switches: state.switchesUsed,
            tasks_done: tasksDoneInRun,
          }),
        );
        return 0;
      }
      // max-tasks budget：达到上限即收尾（队列留待下次 run）
      if (cfg.control.maxTasks > 0 && tasksDoneInRun >= cfg.control.maxTasks) {
        state.log('run_done', { pending: state.queue.length, reason: 'max_tasks', max_tasks: cfg.control.maxTasks });
        writeFinalReport(cfg, state, 'max_tasks');
        console.log(
          JSON.stringify({
            run_done: true,
            reason: 'max_tasks',
            tasks_done: tasksDoneInRun,
            queue: state.queue.length,
          }),
        );
        return 0;
      }
      task.status = 'running';
      state.save();
      let outcome: string;
      try {
        outcome = await runTask(cfg, state, task, sim);
      } catch (e) {
        if (e instanceof HarnessInterrupt || e instanceof StopRequested) throw e;
        // never let one flaky task kill the run
        state.log('task_error', { task: task.text.slice(0, 60), error: String(e) });
        skip(state, task, `exception: ${e}`);
        outcome = 'skipped';
      }
      if (outcome === 'done') {
        tasksDoneInRun += 1;
        gitCommit(cfg, task);
        // 长对话检查点（可选）：每 N 个任务让 Agent 把进度固化到 HARNESS_STATE.md
        if (cfg.prompt.checkpointEveryTasks > 0 && tasksDoneInRun % cfg.prompt.checkpointEveryTasks === 0) {
          try {
            state.log('checkpoint', { task: task.text.slice(0, 60), n: tasksDoneInRun });
            await sendAndWait(cfg, state, CHECKPOINT_PROMPT(cfg.projectDir), 'checkpoint');
          } catch (e) {
            if (e instanceof HarnessInterrupt || e instanceof StopRequested) throw e;
            state.log('checkpoint_failed', { error: String(e) });
          }
        }
        // 任务完成后重新加载 TODO.md：吸收 Agent 追加的新任务
        const fresh = reloadQueue(cfg, state, 'task_done');
        if (fresh !== null) {
          // load() 从 snapshot 恢复预算/冷却；同步当前内存值再保存
          fresh.switchesUsed = state.switchesUsed;
          fresh.cooldownUntil = state.cooldownUntil;
          state = fresh;
          state.save();
        }
      }
      if (outcome === 'abort') {
        state.log('run_abort');
        state.save();
        writeFinalReport(cfg, state, 'run_abort');
        return 2; // distinct from crash(1): watchdog must NOT restart on abort
      }
      state.save();
    }
  } catch (e) {
    if (e instanceof StopRequested) {
      state.log('run_abort', { reason: 'stop_file' });
      state.save();
      console.log('[stop] 检测到 STOP 文件，已优雅中止（退出码 2，watchdog 不重启）。删除 STOP 后可继续。');
      writeFinalReport(cfg, state, 'stop_file');
      return 2;
    }
    if (e instanceof HarnessInterrupt) {
      state.log('interrupt');
      state.save();
      console.log('\n[interrupt] 状态已保存，可再次运行续跑');
      return 130;
    }
    // 运行级意外错误：尽力保存状态后抛出（退出码 1 = 崩溃，watchdog 会重启）
    try {
      state.log('run_error', { error: String(e) });
      state.save();
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    interruptRequested = false;
    process.removeListener('SIGINT', onSigint);
  }
}

export function isAdmin(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const out = cp.execSync(
      'powershell -NoProfile -NonInteractive -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim() === 'True';
  } catch {
    return false;
  }
}

export interface LoopArgs {
  config?: string;
  project?: string;
  mode?: string;
  'dry-run'?: boolean;
  'check-config'?: boolean;
  'assistant-dry-run'?: boolean;
  'assistant-refresh-only'?: boolean;
  'detect-only'?: boolean;
  'detect-seconds'?: number;
  'inject-limit-node'?: boolean;
  'max-tasks'?: number;
  'max-switches'?: number;
  [key: string]: unknown;
}

export async function main(argv: string[]): Promise<number> {
  const minimist = require('minimist') as (args: string[], opts?: unknown) => LoopArgs;
  const args = minimist(argv, {
    string: ['config', 'project', 'mode'],
    boolean: ['dry-run', 'check-config', 'assistant-dry-run', 'assistant-refresh-only', 'detect-only', 'inject-limit-node'],
    default: { 'detect-seconds': 20.0 },
  });

  if (args.project) setProjectOverride(args.project);
  let cfg = loadConfig(args.config ? path.resolve(args.config) : null);
  if (args.mode) cfg.mode = args.mode;
  if (args['dry-run']) cfg.mode = 'dry-run';
  // 运行预算覆盖（可控性）：--max-tasks N / --max-switches N
  if (args['max-tasks'] !== undefined) {
    cfg.control.maxTasks = Math.max(0, Math.trunc(Number(args['max-tasks'])));
  }
  if (args['max-switches'] !== undefined) {
    cfg.retry.maxTotalAccountSwitchesPerRun = Math.max(0, Math.trunc(Number(args['max-switches'])));
  }

  if (args['check-config']) return cmdCheckConfig(cfg);
  if (args['assistant-dry-run']) return cmdAssistantDryRun(cfg);
  if (args['inject-limit-node']) return cmdInjectLimitNode(cfg);
  if (args['detect-only']) return cmdDetectOnly(cfg, Number(args['detect-seconds'] ?? 20.0));
  if (args['assistant-refresh-only']) {
    if (!isAdmin()) {
      console.log('[fail] --assistant-refresh-only 需要管理员权限（换号助手要求提升）。请用管理员终端运行。');
      return 2;
    }
    return cmdAssistantRefreshOnly(cfg);
  }
  if (cfg.mode === 'dry-run') return cmdDryRun(cfg); // read-only: parse queue + report, no send/kill/click

  if ((cfg.mode === 'live' || cfg.mode === 'limit-sim') && !isAdmin()) {
    console.log('[fail] live / limit-sim 模式需要管理员权限（Cursor 与换号助手都要求提升）。');
    console.log('       请用管理员终端运行，或双击 unattended\\run_unattended.bat（参数 live/limit-sim，启动时弹一次 UAC）。');
    return 2;
  }

  cursor.init(cfg);
  const problems = validate(cfg);
  if (problems.length) {
    for (const p of problems) console.log('[!]', p);
    console.log('[fail] 配置有问题，先 --check-config');
    return 2;
  }

  console.log(`[mode] ${cfg.mode}  project=${cfg.projectDir}`);
  if (cfg.mode === 'live' || cfg.mode === 'limit-sim') {
    console.log(
      '[注意] 该模式会真实点击换号助手并切换 Cursor 账号。' +
        '自动轮号绕过用量限制违反 Cursor ToS，账号存在风控/封禁风险，风险自担。',
    );
  }
  return run(cfg);
}
