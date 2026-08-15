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

/** 无人值守 Cursor 编码循环 — state machine + CLI。
 *
 * 用法（node dist/loop.js … 或 curloop --check-config …）：
 *   curloop --check-config
 *   curloop --dry-run
 *   curloop --mode live --project D:\\2026AppDev\\RAGLab
 *   curloop --mode limit-sim
 */

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
    await sleep(cd);
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
    await sleep(5);
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
    await sleep(interval);
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
    await sleep(interval);
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
      await sleep(interval);
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
  const prompt = task.prompt(cfg.projectDir);
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
  state.switchesUsed = 0; // 每次 run 独立换号预算（不跨 run 累计）
  ui.init();

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.once('SIGINT', onSigint);
  try {
    while (true) {
      if (interrupted) {
        state.log('interrupt');
        state.save();
        console.log('\n[interrupt] 状态已保存，可再次运行续跑');
        return 130;
      }
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
        state.log('run_done', { pending: 0 });
        console.log(JSON.stringify({ run_done: true, queue: state.queue.length, switches: state.switchesUsed }));
        return 0;
      }
      task.status = 'running';
      state.save();
      let outcome: string;
      try {
        outcome = await runTask(cfg, state, task, sim);
      } catch (e) {
        // never let one flaky task kill the run
        state.log('task_error', { task: task.text.slice(0, 60), error: String(e) });
        skip(state, task, `exception: ${e}`);
        outcome = 'skipped';
      }
      if (outcome === 'done') {
        gitCommit(cfg, task);
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
        return 2; // distinct from crash(1): watchdog must NOT restart on abort
      }
      state.save();
    }
  } finally {
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
  [key: string]: unknown;
}

export async function main(argv: string[]): Promise<number> {
  const minimist = require('minimist') as (args: string[], opts?: unknown) => LoopArgs;
  const args = minimist(argv, { string: ['config', 'project', 'mode'], boolean: ['dry-run', 'check-config', 'assistant-dry-run', 'assistant-refresh-only', 'detect-only', 'inject-limit-node'], default: { 'detect-seconds': 20.0 } });

  if (args.project) setProjectOverride(args.project);
  let cfg = loadConfig(args.config ? path.resolve(args.config) : null);
  if (args.mode) cfg.mode = args.mode;
  if (args['dry-run']) cfg.mode = 'dry-run';

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
