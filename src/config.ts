import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const PKG_DIR = path.resolve(__dirname, '..');
// 仓库内默认配置（干净默认值，不含任何本机路径）
export const DEFAULT_CONFIG = path.join(PKG_DIR, 'config.default.json');

// 用户配置（分发后外置，不入库）：%APPDATA%\curloop\config.json
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
export const USER_CONFIG_DIR = path.join(appData, 'curloop');
export const USER_CONFIG = path.join(USER_CONFIG_DIR, 'config.json');

// 由 CLI 在 load 之前注入（--project 覆盖）
export let PROJECT_OVERRIDE: string | null = null;

export function setProjectOverride(p: string | null): void {
  PROJECT_OVERRIDE = p;
}

export function expandEnv(s: string): string {
  if (!s) return s;
  s = s.replace(/%APPDATA%/g, process.env.APPDATA || '');
  s = s.replace(/%USERPROFILE%/g, os.homedir());
  // %VAR% expansion
  return s.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? '');
}

// current_branch 缓存：.git/HEAD 内容基本不变，按 (path, mtimeMs) 命中
const branchCache = new Map<string, { mtime: number; branch: string }>();

export function slug(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]/g, '_').replace(/ /g, '_');
  return s || 'default';
}

export function currentBranch(projectDir: string): string {
  const candidates: string[] = [];
  const head = path.join(projectDir, '.git', 'HEAD');
  if (fs.existsSync(head)) candidates.push(head);
  const gitfile = path.join(projectDir, '.git');
  try {
    if (fs.statSync(gitfile).isFile()) {
      const text = fs.readFileSync(gitfile, 'utf-8').trim();
      if (text.startsWith('gitdir:')) {
        candidates.push(path.join(text.slice('gitdir:'.length).trim(), 'HEAD'));
      }
    }
  } catch {
    /* ignore */
  }
  for (const h of candidates) {
    try {
      const stat = fs.statSync(h);
      const hit = branchCache.get(h);
      if (hit && hit.mtime === stat.mtimeMs) return hit.branch;
      const text = fs.readFileSync(h, 'utf-8').trim();
      let branch: string | null = null;
      if (text.startsWith('ref: refs/heads/')) {
        branch = text.slice('ref: refs/heads/'.length).trim();
      } else if (text && !text.startsWith('ref:')) {
        branch = text.slice(0, 7); // detached HEAD: 短 commit hash
      }
      if (branch) {
        branchCache.set(h, { mtime: stat.mtimeMs, branch });
        return branch;
      }
    } catch {
      /* continue */
    }
  }
  return 'default';
}

export function projectStateKey(projectDir: string): string {
  const p = path.resolve(projectDir);
  const digest = crypto.createHash('sha1').update(p, 'utf-8').digest('hex').slice(0, 8);
  const name = path.basename(p) || 'default';
  return slug(`${name}@${currentBranch(p)}_${digest}`);
}

function strPath(d: Record<string, unknown>, key: string): string | null {
  const v = d[key];
  if (v === null || v === undefined || v === '') return null;
  return expandEnv(String(v));
}

function num(d: Record<string, unknown>, key: string, def: number): number {
  const v = d[key];
  if (v === null || v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function detectCursorExe(): string | null {
  const pf = process.env.PROGRAMFILES || path.join('C:', 'Program Files');
  const la = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf, 'cursor', 'Cursor.exe'),
    path.join(la, 'Programs', 'cursor', 'Cursor.exe'),
    path.join(la, 'Anysphere', 'Cursor.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 内置模板图片目录：dist/assets/templates（构建时从 src/assets 复制）。 */
export function builtinTemplatePath(name: 'refresh_cursor' | 'confirm_ok'): string {
  return path.join(__dirname, 'assets', 'templates', `${name}.png`);
}

/** 自动检测换号助手模板图片（refresh_cursor / confirm_ok）：
 *  优先内置（打包自带，用户无需自己截图），内置缺失时才扫描桌面 + 下载目录。 */
export function detectTemplate(name: 'refresh_cursor' | 'confirm_ok'): string | null {
  const builtin = builtinTemplatePath(name);
  try {
    if (fs.existsSync(builtin)) return builtin;
  } catch {
    /* ignore */
  }
  for (const d of [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Downloads')]) {
    let hits: string[] = [];
    try {
      if (fs.existsSync(d)) {
        hits = fs
          .readdirSync(d)
          .filter((f) => new RegExp(`^${name}.*\\.png$`, 'i').test(f))
          .map((f) => path.join(d, f));
      }
    } catch {
      hits = [];
    }
    if (hits.length) {
      hits.sort();
      return hits[hits.length - 1];
    }
  }
  return null;
}

export function detectAssistantExe(): string | null {
  for (const d of [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Downloads')]) {
    let hits: string[] = [];
    try {
      if (fs.existsSync(d)) {
        hits = fs
          .readdirSync(d)
          .filter((f) => /^CursorLoginAssistant-.*\.exe$/i.test(f))
          .map((f) => path.join(d, f));
      }
    } catch {
      hits = [];
    }
    if (hits.length) {
      hits.sort();
      return hits[hits.length - 1];
    }
  }
  return null;
}

export interface CursorConfig {
  exe: string;
  profile: string;
  port: number;
  remoteAllowOrigins: string;
}

export function cursorFromDict(d: Record<string, unknown>): CursorConfig {
  let exe = strPath(d, 'exe');
  if (!exe) exe = detectCursorExe() || path.join('C:', 'Program Files', 'cursor', 'Cursor.exe');
  const profile = strPath(d, 'profile') || path.join(process.env.APPDATA || '', 'Cursor');
  return {
    exe,
    profile,
    port: Math.trunc(num(d, 'port', 9333)),
    remoteAllowOrigins: String(d['remote_allow_origins'] ?? '*'),
  };
}

export interface LoginAssistantConfig {
  exe: string;
  refreshTemplate: string | null;
  confirmTemplate: string | null;
  confidence: number;
  launchWaitS: number;
  confirmWaitS: number;
  closeAfterRefresh: boolean;
}

export function loginAssistantFromDict(d: Record<string, unknown>): LoginAssistantConfig {
  let exe = strPath(d, 'exe');
  if (!exe) exe = detectAssistantExe() || '';
  return {
    exe,
    refreshTemplate: strPath(d, 'refresh_template'),
    confirmTemplate: strPath(d, 'confirm_template'),
    confidence: num(d, 'confidence', 0.85),
    launchWaitS: num(d, 'launch_wait_s', 8.0),
    confirmWaitS: num(d, 'confirm_wait_s', 8.0),
    closeAfterRefresh: Boolean(d['close_after_refresh'] ?? true),
  };
}

export interface DetectionConfig {
  limitRequireRecent: boolean;
  limitKeywordsEn: string[];
  limitKeywordsCn: string[];
  loggedOutKeywords: string[];
}

export function detectionFromDict(d: Record<string, unknown>): DetectionConfig {
  return {
    limitRequireRecent: Boolean(d['limit_require_recent'] ?? true),
    limitKeywordsEn: (d['limit_keywords_en'] as string[]) || [],
    limitKeywordsCn: (d['limit_keywords_cn'] as string[]) || [],
    loggedOutKeywords: (d['logged_out_keywords'] as string[]) || [],
  };
}

export interface Timeouts {
  cdpReadyS: number;
  domReadyS: number;
  replyMaxS: number;
  completionStablePolls: number;
  completionPollIntervalS: number;
  minElapsedBeforeCompleteS: number;
  switchTokenTimeoutS: number;
}

export function timeoutsFromDict(d: Record<string, unknown>): Timeouts {
  return {
    cdpReadyS: num(d, 'cdp_ready_s', 90.0),
    domReadyS: num(d, 'dom_ready_s', 120.0),
    replyMaxS: num(d, 'reply_max_s', 0.0),
    completionStablePolls: Math.trunc(num(d, 'completion_stable_polls', 4)),
    completionPollIntervalS: num(d, 'completion_poll_interval_s', 3.0),
    minElapsedBeforeCompleteS: num(d, 'min_elapsed_before_complete_s', 10.0),
    switchTokenTimeoutS: num(d, 'switch_token_timeout_s', 60.0),
  };
}

export interface RetryConfig {
  hangRetriesPerTask: number;
  sendRetries: number;
  maxTotalAccountSwitchesPerRun: number;
  cooldownBetweenSwitchesS: number;
  autoExtend: boolean;
  autoExtendMaxIterations: number;
}

export function retryFromDict(d: Record<string, unknown>): RetryConfig {
  return {
    hangRetriesPerTask: Math.trunc(num(d, 'hang_retries_per_task', 1)),
    sendRetries: Math.trunc(num(d, 'send_retries', 2)),
    maxTotalAccountSwitchesPerRun: Math.trunc(num(d, 'max_total_account_switches_per_run', 0)),
    cooldownBetweenSwitchesS: num(d, 'cooldown_between_switches_s', 30.0),
    autoExtend: Boolean(d['auto_extend'] ?? false),
    autoExtendMaxIterations: Math.trunc(num(d, 'auto_extend_max_iterations', 20)),
  };
}

export interface UiConfig {
  periodicStatusS: number;
}

export function uiFromDict(d: Record<string, unknown>): UiConfig {
  return {
    periodicStatusS: num(d, 'periodic_status_s', 180.0),
  };
}

export interface PromptConfig {
  /** 任务提示词附带仓库上下文（git 状态/最近提交/HARNESS_STATE.md 摘要） */
  taskContext: boolean;
  /** 长对话检查点：每完成 N 个任务让 Agent 把进度写入 HARNESS_STATE.md（0 = 关闭） */
  checkpointEveryTasks: number;
  /** 队列空且两层扩展都无新任务时，再让 Agent 对照 FinalGoal 做一次最终验收 */
  finalVerify: boolean;
  /** 任务提示词附带 FinalGoal 前段（目标提示，默认关——FinalGoal 可能很长） */
  goalInTask: boolean;
  /** 自定义任务提示词文件（路径可为相对 <projectDir>；存在则完全覆盖内置任务提示词） */
  taskPromptFile: string;
}

export function promptFromDict(d: Record<string, unknown>): PromptConfig {
  return {
    taskContext: Boolean(d['task_context'] ?? true),
    checkpointEveryTasks: Math.trunc(num(d, 'checkpoint_every_tasks', 0)),
    finalVerify: Boolean(d['final_verify'] ?? false),
    goalInTask: Boolean(d['goal_in_task'] ?? false),
    taskPromptFile: strPath(d, 'task_prompt_file') || '',
  };
}

export interface ThreadConfig {
  /** 上下文轮转：每完成 N 个任务点「New Chat」开新线程，先写 HARNESS_STATE.md
   *  再发续接提示词恢复上下文（真正的长对话压缩；0 = 关闭，保持单线程） */
  rotateEveryTasks: number;
}

export function threadFromDict(d: Record<string, unknown>): ThreadConfig {
  return {
    rotateEveryTasks: Math.trunc(num(d, 'rotate_every_tasks', 0)),
  };
}

export interface ControlConfig {
  /** 单次 run 最多完成任务数（0 = 不限） */
  maxTasks: number;
  /** 停止文件：存在即优雅中止（空 = <projectDir>/STOP）。退出码 2（watchdog 不重启） */
  stopFile: string;
}

export function controlFromDict(d: Record<string, unknown>): ControlConfig {
  return {
    maxTasks: Math.trunc(num(d, 'max_tasks', 0)),
    stopFile: strPath(d, 'stop_file') || '',
  };
}

// 运行时属性（Object.defineProperties 注入的 getter；构造时不可直接赋值）
export interface Config {
  projectDir: string;
  todoPath: string;
  finalGoalFile: string;
  autoPlanTodo: boolean;
  gitCommitAfterTask: boolean;
  cursor: CursorConfig;
  loginAssistant: LoginAssistantConfig;
  detection: DetectionConfig;
  timeouts: Timeouts;
  retry: RetryConfig;
  ui: UiConfig;
  prompt: PromptConfig;
  thread: ThreadConfig;
  control: ControlConfig;
  stateDir: string;
  eventLog: string;
  mode: string;
  readonly todoFile: string;
  readonly finalGoalFilePath: string;
  readonly projectStateDir: string;
  readonly snapshotFile: string;
  readonly eventLogFile: string;
  readonly stateLockFile: string;
}

type ConfigBase = Omit<
  Config,
  'todoFile' | 'finalGoalFilePath' | 'projectStateDir' | 'snapshotFile' | 'eventLogFile' | 'stateLockFile'
>;

export function fromDict(d: Record<string, unknown>): Config {
  const projectDir = path.resolve(
    expandEnv(PROJECT_OVERRIDE || String(d['project_dir'] || '')) || process.cwd(),
  );
  const stateDir = strPath(d, 'state_dir') || path.join(USER_CONFIG_DIR, 'runstate');
  const base: ConfigBase = {
    projectDir,
    todoPath: String(d['todo_path'] ?? 'TODO.md'),
    finalGoalFile: String(d['final_goal_file'] ?? 'FinalGoal.md'),
    autoPlanTodo: Boolean(d['auto_plan_todo'] ?? true),
    gitCommitAfterTask: Boolean(d['git_commit_after_task'] ?? true),
    cursor: cursorFromDict((d['cursor'] as Record<string, unknown>) || {}),
    loginAssistant: loginAssistantFromDict((d['login_assistant'] as Record<string, unknown>) || {}),
    detection: detectionFromDict((d['detection'] as Record<string, unknown>) || {}),
    timeouts: timeoutsFromDict((d['timeouts'] as Record<string, unknown>) || {}),
    retry: retryFromDict((d['retry'] as Record<string, unknown>) || {}),
    ui: uiFromDict((d['ui'] as Record<string, unknown>) || {}),
    prompt: promptFromDict((d['prompt'] as Record<string, unknown>) || {}),
    thread: threadFromDict((d['thread'] as Record<string, unknown>) || {}),
    control: controlFromDict((d['control'] as Record<string, unknown>) || {}),
    stateDir,
    eventLog: String(d['event_log'] ?? 'events.jsonl'),
    mode: String(d['mode'] ?? 'dry-run'),
  };
  const cfg = base as Config;
  // 运行时属性都是动态 getter：projectDir 被 CLI 覆盖后（cfg.projectDir = X），
  // todoFile / projectStateDir 等必须跟随 —— 与 Python 版 @property 语义一致。
  Object.defineProperties(cfg, {
    todoFile: { enumerable: true, get: () => path.join(base.projectDir, base.todoPath) },
    finalGoalFilePath: { enumerable: true, get: () => path.join(base.projectDir, base.finalGoalFile) },
    projectStateDir: {
      enumerable: true,
      get: () => path.join(base.stateDir, projectStateKey(base.projectDir)),
    },
    snapshotFile: { enumerable: true, get: () => path.join(cfg.projectStateDir, 'snapshot.json') },
    eventLogFile: { enumerable: true, get: () => path.join(cfg.projectStateDir, 'events.jsonl') },
    stateLockFile: { enumerable: true, get: () => path.join(cfg.projectStateDir, '.lock') },
  });
  return cfg;
}

/** 合并加载：默认配置 → %APPDATA% 用户配置 → --config 显式指定。 */
export function load(pathArg?: string | null): Config {
  const data: Record<string, unknown> = {};
  const sources: string[] = [DEFAULT_CONFIG, USER_CONFIG];
  if (pathArg && path.resolve(pathArg) !== path.resolve(DEFAULT_CONFIG)) {
    sources.push(pathArg);
  }
  for (const src of sources) {
    if (!src || !fs.existsSync(src)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(src, 'utf-8')) as Record<string, unknown>;
      Object.assign(data, parsed);
    } catch (e) {
      console.error(`[config] 警告：读取 ${src} 失败：${String(e)}，已跳过`);
    }
  }
  return fromDict(data);
}

export function validate(cfg: Config): string[] {
  const problems: string[] = [];
  if (!cfg.cursor.exe || !fs.existsSync(cfg.cursor.exe)) {
    problems.push(`cursor.exe 不存在: ${cfg.cursor.exe}`);
  }
  if (!fs.existsSync(cfg.cursor.profile)) {
    problems.push(`cursor profile 目录不存在: ${cfg.cursor.profile}`);
  }
  if (!cfg.loginAssistant.exe || !fs.existsSync(cfg.loginAssistant.exe)) {
    problems.push(`login_assistant.exe 不存在: ${cfg.loginAssistant.exe}`);
  }
  for (const [name, p] of [
    ['refresh_template', cfg.loginAssistant.refreshTemplate],
    ['confirm_template', cfg.loginAssistant.confirmTemplate],
  ] as const) {
    if (p && !fs.existsSync(p)) {
      problems.push(`login_assistant.${name} 不存在: ${p}`);
    }
  }
  if (!fs.existsSync(cfg.projectDir)) {
    problems.push(`project_dir 不存在: ${cfg.projectDir}`);
  }
  return problems;
}
