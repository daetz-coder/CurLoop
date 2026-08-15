import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { load as loadConfig, Config, USER_CONFIG, detectTemplate } from './config';
import { buildStatus, loadEvents } from './observer';
import { isAdmin, stopFilePath } from './loop';
import { INIT_GOAL, INIT_TODO } from './cli';
import * as cursor from './cursor';
import { CompletionTracker } from './detection';
import { sleep } from './cdp';
import { parseAll } from './todoQueue';
import { PROMPT_DEFS, PROMPT_OVERRIDE_DIR, promptOverridePath, promptSource } from './prompts';

/**
 * curloop Web 界面（仿 dsh web）：`curloop web` 启动本地 HTTP 服务器并自动打开浏览器。
 *
 * - 可视化：runstate 统计卡片、SVG 轨迹时间线、事件表、TODO 队列、账号、结束报告
 * - 控制：运行 / 停止（STOP 文件）/ 只规划 / 初始化，全部在浏览器里完成（CLI 搬到 Web）
 * - 运行通过子进程执行 `bin/curloop.js run ...`，stdout 流式回传浏览器（轮询）
 * - 纯 Node 内置模块，零新依赖；只绑定 127.0.0.1
 */

export interface WebArgs {
  port?: number;
  project?: string;
  mode?: string;
  'no-open'?: boolean;
  [key: string]: unknown;
}

const DEFAULT_PORT = 3080; // 与 dsh web 同端口，习惯一致

// 静态资源：优先 dist/web（打包），开发目录回退 src/web
const WEB_DIRS = [path.join(__dirname, 'web'), path.join(__dirname, '..', 'src', 'web')];
const WEB_DIR: string = WEB_DIRS.find((d) => fs.existsSync(path.join(d, 'index.html'))) || WEB_DIRS[0];

interface ConsoleLine {
  n: number;
  text: string;
}

const consoleBuf: ConsoleLine[] = [];
let consoleSeq = 0;

interface ActiveChild {
  kind: 'run' | 'plan';
  startedAt: number;
  proc: cp.ChildProcess;
  exitCode: number | null;
  cfg: Config;
}

let activeChild: ActiveChild | null = null;

function logLine(text: string): void {
  consoleBuf.push({ n: consoleSeq++, text });
  if (consoleBuf.length > 4000) consoleBuf.splice(0, consoleBuf.length - 4000);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d: Buffer) => {
      body += d.toString('utf-8');
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

// ------------------------------------------------------------------- child ----
function spawnTool(cfg: Config, kind: 'run', extra: string[]): { ok: boolean; error?: string } {
  if (activeChild) return { ok: false, error: `已有 ${activeChild.kind} 在运行，请先停止` };
  const entry = path.join(__dirname, '..', 'bin', 'curloop.js');
  const args = [entry, kind, '--project', cfg.projectDir, ...extra];
  logLine(`\n>>> [web] 启动 ${kind}: node ${args.join(' ')}`);
  let child: cp.ChildProcess;
  try {
    child = cp.spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    logLine(`[web] 启动失败: ${String(e)}`);
    return { ok: false, error: String(e) };
  }
  activeChild = { kind, startedAt: Date.now(), proc: child, exitCode: null, cfg };
  child.stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString('utf-8').split(/\r?\n/)) {
      if (line) logLine(line);
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString('utf-8').split(/\r?\n/)) {
      if (line) logLine(`[stderr] ${line}`);
    }
  });
  child.on('exit', (code) => {
    if (activeChild && activeChild.proc === child) {
      activeChild.exitCode = code;
      logLine(`\n>>> [web] ${kind} 结束，退出码 ${code}（0=完成 1=崩溃 2=中止/配置 130=Ctrl-C）`);
      setTimeout(() => {
        if (activeChild && activeChild.proc === child) activeChild = null;
      }, 100);
    }
  });
  child.on('error', (e) => {
    logLine(`[web] ${kind} 进程错误: ${String(e)}`);
  });
  return { ok: true };
}

function stopChild(): void {
  if (!activeChild) return;
  // 优雅：先写 STOP 文件让 run() 收尾（退出码 2），3 秒后强杀
  const stop = stopFilePath(activeChild.cfg);
  try {
    fs.writeFileSync(stop, `stop requested by web ui at ${new Date().toISOString()}\n`, 'utf-8');
  } catch {
    /* ignore */
  }
  logLine('[web] 已写 STOP 文件，等待优雅退出…');
  const proc = activeChild.proc;
  setTimeout(() => {
    if (proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }, 3000);
}

function cfgFor(cwd: string): Config {
  const cfg = loadConfig(null);
  cfg.projectDir = path.resolve(cwd);
  return cfg;
}

// 服务器运行期配置：/api/config 可改（写入 %APPDATA%\curloop\config.json 并热重载）
let currentCfg: Config | null = null;
function getCfg(): Config {
  if (!currentCfg) currentCfg = cfgFor(process.cwd());
  return currentCfg;
}

/** 判断某路径是否被用户显式配置过（只看用户配置文件，默认配置不算）。 */
function pathKeyConfigured(section: string, key: string): boolean {
  try {
    if (!fs.existsSync(USER_CONFIG)) return false;
    const data = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf-8')) as Record<string, unknown>;
    const sec = data[section];
    return Boolean(sec && typeof sec === 'object' && (sec as Record<string, unknown>)[key] !== undefined);
  } catch {
    return false;
  }
}

/** 生成路径检测报告：未配置的项自动检测（每次实时重跑）。 */
function detectReport(cfg: Config): Record<string, unknown> {
  const item = (label: string, key: string, value: string, userSet: boolean): Record<string, unknown> => ({
    label,
    key,
    value,
    found: Boolean(value) && fs.existsSync(value),
    source: userSet ? '已配置' : '自动检测',
  });
  const items = [
    item('Cursor 可执行文件', 'cursor.exe', cfg.cursor.exe, pathKeyConfigured('cursor', 'exe')),
    item('Cursor 配置目录', 'cursor.profile', cfg.cursor.profile, pathKeyConfigured('cursor', 'profile')),
    item('换号助手', 'login_assistant.exe', cfg.loginAssistant.exe, pathKeyConfigured('login_assistant', 'exe')),
    item('刷新模板图片', 'login_assistant.refresh_template', cfg.loginAssistant.refreshTemplate || detectTemplate('refresh_cursor') || '', pathKeyConfigured('login_assistant', 'refresh_template')),
    item('确认模板图片', 'login_assistant.confirm_template', cfg.loginAssistant.confirmTemplate || detectTemplate('confirm_ok') || '', pathKeyConfigured('login_assistant', 'confirm_template')),
  ];
  const foundCount = items.filter((i) => i['found']).length;
  return { ok: true, items, found: foundCount, total: items.length };
}

/** 更新用户配置：把分节参数合并进 %APPDATA%\curloop\config.json 并热重载。 */
function applyConfigUpdate(updates: {
  maxTasks?: number;
  maxSwitches?: number;
  rotateEveryTasks?: number;
  checkpointEveryTasks?: number;
  finalVerify?: boolean;
}): { ok: boolean; error?: string; config?: Record<string, unknown> } {
  try {
    let merged: Record<string, unknown> = {};
    if (fs.existsSync(USER_CONFIG)) {
      try {
        merged = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf-8')) as Record<string, unknown>;
      } catch {
        merged = {};
      }
    }
    const setSec = (sec: string, key: string, v: unknown): void => {
      const section = (merged[sec] as Record<string, unknown>) || {};
      section[key] = v;
      merged[sec] = section;
    };
    if (updates.maxTasks !== undefined) setSec('control', 'max_tasks', updates.maxTasks);
    if (updates.maxSwitches !== undefined) setSec('retry', 'max_total_account_switches_per_run', updates.maxSwitches);
    if (updates.rotateEveryTasks !== undefined) setSec('thread', 'rotate_every_tasks', updates.rotateEveryTasks);
    if (updates.checkpointEveryTasks !== undefined) setSec('prompt', 'checkpoint_every_tasks', updates.checkpointEveryTasks);
    if (updates.finalVerify !== undefined) setSec('prompt', 'final_verify', updates.finalVerify);
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    fs.writeFileSync(USER_CONFIG, JSON.stringify(merged, null, 2), 'utf-8');
    // 热重载：保留当前项目目录
    const project = getCfg().projectDir;
    currentCfg = cfgFor(project);
    logLine(`[web] /api/config 已保存到 ${USER_CONFIG} 并热重载`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ------------------------------------------------------------------- routes ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

function serveStatic(res: http.ServerResponse, relRaw: string): boolean {
  // 解码 + 去多余斜杠后解析；防目录穿越：只允许 WEB_DIR 内的文件
  let rel: string;
  try {
    rel = decodeURIComponent(relRaw).replace(/^\/+/, '');
  } catch {
    rel = relRaw.replace(/^\/+/, '');
  }
  const base = path.resolve(WEB_DIR);
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep) && target !== base) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return true;
  }
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return true;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(target).pipe(res);
    return true;
  } catch {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return true;
  }
}

function router(): http.RequestListener {
  return async (req, res) => {
    const cfg = getCfg();
    const url = (req.url || '/').split('?')[0];
    try {
      // 静态资源：/ 与 /index.html → 页面；/vendor/* 与其余文件 → 文件服务
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && !url.startsWith('/api/')) {
        if (serveStatic(res, url.slice(1))) return;
      }
      // ---------------- API ----------------
      if (req.method === 'GET' && url === '/api/status') {
        const st = buildStatus(cfg.projectDir, cfg.stateDir);
        sendJson(res, 200, {
          ok: true,
          project: cfg.projectDir,
          stateDir: cfg.stateDir,
          admin: isAdmin(),
          running: Boolean(activeChild),
          runKind: activeChild?.kind ?? null,
          startedAt: activeChild?.startedAt ?? null,
          exitCode: activeChild?.exitCode ?? null,
          status: st,
          config: {
            mode: cfg.mode,
            todoFile: cfg.todoFile,
            finalGoalFile: cfg.finalGoalFilePath,
            cursorExe: cfg.cursor.exe,
            cursorProfile: cfg.cursor.profile,
            assistantExe: cfg.loginAssistant.exe,
            refreshTemplate: cfg.loginAssistant.refreshTemplate,
            confirmTemplate: cfg.loginAssistant.confirmTemplate,
            maxTasks: cfg.control.maxTasks,
            maxSwitches: cfg.retry.maxTotalAccountSwitchesPerRun,
            checkpointEveryTasks: cfg.prompt.checkpointEveryTasks,
            finalVerify: cfg.prompt.finalVerify,
            rotateEveryTasks: cfg.thread.rotateEveryTasks,
            goalInTask: cfg.prompt.goalInTask,
          },
        });
        return;
      }
      if (req.method === 'GET' && url === '/api/events') {
        const q = new URL(req.url || '', 'http://x');
        const n = Math.max(1, Math.min(1000, Number(q.searchParams.get('n') ?? 300)));
        const evs = loadEvents(cfg.projectDir, cfg.stateDir).slice(-n).reverse();
        sendJson(res, 200, { ok: true, events: evs });
        return;
      }
      if (req.method === 'GET' && url === '/api/dirs') {
        // 服务端目录浏览（目标项目选择器）：空 path 返回盘符，否则列出子目录
        const q = new URL(req.url || '', 'http://x');
        const raw = q.searchParams.get('path') || '';
        let dirs: string[] = [];
        let parent: string | null = null;
        let resolved: string | null = null;
        try {
          if (!raw) {
            for (let i = 65; i <= 90; i++) {
              const d = String.fromCharCode(i) + ':\\';
              try {
                if (fs.existsSync(d)) dirs.push(d);
              } catch {
                /* ignore */
              }
            }
          } else {
            resolved = path.resolve(raw);
            parent = path.dirname(resolved);
            if (parent === resolved) parent = null;
            dirs = fs
              .readdirSync(resolved, { withFileTypes: true })
              .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
              .map((e) => path.join(resolved as string, e.name))
              .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
          }
        } catch {
          /* 路径不可读：返回空 */
        }
        sendJson(res, 200, { ok: true, path: resolved, parent, dirs: dirs.slice(0, 500) });
        return;
      }
      if (req.method === 'GET' && url === '/api/project') {
        // 项目检测：FinalGoal / TODO（含待办数）/ git / 记忆文件
        const q = new URL(req.url || '', 'http://x');
        const dir = q.searchParams.get('dir') ? path.resolve(String(q.searchParams.get('dir'))) : cfg.projectDir;
        const goalP = path.join(dir, cfg.finalGoalFile);
        const todoP = path.join(dir, cfg.todoPath);
        let todoPending = 0;
        try {
          if (fs.existsSync(todoP)) todoPending = parseAll(todoP).filter((t) => !t.done).length;
        } catch {
          /* ignore */
        }
        sendJson(res, 200, {
          ok: true,
          project: dir,
          exists: fs.existsSync(dir),
          hasGoal: fs.existsSync(goalP),
          hasTodo: fs.existsSync(todoP),
          todoPending,
          isGit: fs.existsSync(path.join(dir, '.git')),
          hasStateFile: fs.existsSync(path.join(dir, 'HARNESS_STATE.md')),
        });
        return;
      }
      if (req.method === 'GET' && url === '/api/goal') {
        // FinalGoal.md 内容（无固定格式，前端用 Markdown 渲染）
        const p = cfg.finalGoalFilePath;
        let content = '';
        let exists = false;
        try {
          if (fs.existsSync(p)) {
            content = fs.readFileSync(p, 'utf-8');
            exists = true;
          }
        } catch {
          /* ignore */
        }
        sendJson(res, 200, { ok: true, path: p, exists, content });
        return;
      }
      if (req.method === 'GET' && url === '/api/report') {
        const rp = path.join(cfg.projectStateDir, 'report.json');
        let report: unknown = null;
        if (fs.existsSync(rp)) {
          try {
            report = JSON.parse(fs.readFileSync(rp, 'utf-8'));
          } catch {
            report = null;
          }
        }
        sendJson(res, 200, { ok: true, report });
        return;
      }
      if (req.method === 'GET' && url === '/api/console') {
        const q = new URL(req.url || '', 'http://x');
        const since = Math.max(0, Number(q.searchParams.get('since') ?? 0));
        const lines = consoleBuf.filter((l) => l.n >= since).map((l) => l.text);
        sendJson(res, 200, {
          ok: true,
          running: Boolean(activeChild),
          kind: activeChild?.kind ?? null,
          startedAt: activeChild?.startedAt ?? null,
          exitCode: activeChild?.exitCode ?? null,
          since: consoleSeq,
          lines,
        });
        return;
      }
      if (req.method === 'POST' && url === '/api/run') {
        const body = await readJsonBody(req);
        // 本界面只开放「无人值守」模式：固定 live（换号/续接/直到目标完成），
        // dry-run / limit-sim 仅 CLI 内部使用，不对用户开放
        const mode = 'live';
        const project = body['project'] ? path.resolve(String(body['project'])) : cfg.projectDir;
        if (activeChild) {
          sendJson(res, 409, { ok: false, error: '已有任务在运行' });
          return;
        }
        if (!isAdmin()) {
          sendJson(res, 403, { ok: false, error: '无人值守（live）需要管理员权限——请用管理员终端运行 curloop web' });
          return;
        }
        const runCfg = cfgFor(project);
        runCfg.mode = mode;
        const r = spawnTool(runCfg, 'run', ['--mode', mode]);
        sendJson(res, r.ok ? 200 : 500, r);
        return;
      }
      if (req.method === 'POST' && url === '/api/stop') {
        const sp = stopFilePath(cfg);
        fs.writeFileSync(sp, `stop requested by web ui at ${new Date().toISOString()}\n`, 'utf-8');
        logLine(`[web] /api/stop 已写 ${sp}`);
        sendJson(res, 200, { ok: true, stopFile: sp });
        return;
      }
      if (req.method === 'POST' && url === '/api/ask') {
        // 人在回路：手动向 Cursor 发送一条消息（调试/介入）。
        // 唤醒链路：若 Cursor 未运行（CDP 未就绪）→ ensureReady 自动启动并等待 DOM 就绪 → 再输入。
        // 默认只发送不等待；body.wait = true 时轮询等待回复并返回（最多 5 分钟）。
        const body = await readJsonBody(req);
        const prompt = String(body['prompt'] ?? '').trim();
        if (!prompt) {
          sendJson(res, 400, { ok: false, error: 'prompt 为空' });
          return;
        }
        const wantWait = body['wait'] === true || body['wait'] === 'true' || body['wait'] === 1;
        const project = body['project'] ? path.resolve(String(body['project'])) : cfg.projectDir;
        const askCfg = cfgFor(project);
        cursor.init(askCfg);
        const wake: Record<string, unknown> = {};
        if (!(await cursor.cdpUp(askCfg.cursor.port))) {
          // Cursor 未运行：自动唤醒（启动 + 等 CDP + 等 DOM + 关弹窗）
          logLine(`[web] /api/ask 唤醒 Cursor（CDP ${askCfg.cursor.port} 未就绪，自动启动）...`);
          const er = await cursor.ensureReady(askCfg, project, true);
          wake['ensureReady'] = er;
          if (!er['ok']) {
            const reason = String(er['errors'] ?? 'not ready');
            logLine(`[web] /api/ask 唤醒失败: ${reason}`);
            sendJson(res, 502, { ok: false, error: `唤醒 Cursor 失败: ${reason}`, wake });
            return;
          }
        } else {
          wake['ensureReady'] = { ok: true, alreadyRunning: true };
        }
        const sr = await cursor.sendPrompt(askCfg, prompt, true);
        if (!sr['ok']) {
          const type = (sr['type'] as Record<string, unknown>) || {};
          const reason = String(sr['error'] || type['reason'] || 'send failed');
          logLine(`[web] /api/ask 发送失败: ${reason}`);
          sendJson(res, 500, { ok: false, error: `发送失败: ${reason}`, wake, detail: sr });
          return;
        }
        logLine(`[web] /api/ask 已发送（wait=${wantWait}）`);
        if (!wantWait) {
          sendJson(res, 200, { ok: true, wake, sent: true });
          return;
        }
        // 等待回复（最长 5 分钟）：与 run 相同完成判定（稳定轮询）
        const tracker = new CompletionTracker(
          askCfg.timeouts.completionStablePolls,
          askCfg.timeouts.minElapsedBeforeCompleteS,
          askCfg.timeouts.replyMaxS,
        );
        let prev = new Set<string>();
        const interval = askCfg.timeouts.completionPollIntervalS || 3;
        const deadline = Date.now() + 5 * 60 * 1000;
        let last: Record<string, unknown> = { state: 'busy' };
        while (Date.now() < deadline) {
          await sleep(interval);
          last = await cursor.pollReply(askCfg, tracker, prev);
          const st = String(last['state'] || '');
          if (st === 'done' || st === 'limit' || st === 'logged_out' || st === 'hard_timeout' || st === 'no_page' || st === 'cdp_error') break;
        }
        const reply = (last['reply'] as Record<string, unknown>) || {};
        const replyText = String(reply['lastFull'] || reply['lastTail'] || '');
        logLine(`[web] /api/ask 完成 state=${String(last['state'])} replyLen=${replyText.length}`);
        sendJson(res, 200, {
          ok: last['state'] === 'done',
          wake,
          sent: true,
          state: last['state'],
          reply: replyText.slice(0, 4000),
        });
        return;
      }
      if (req.method === 'GET' && url === '/api/detect') {
        // 配置路径检测报告：先重载配置（重新自动检测 Cursor/换号助手/模板），再输出
        currentCfg = cfgFor(getCfg().projectDir);
        sendJson(res, 200, detectReport(getCfg()));
        return;
      }
      if (req.method === 'POST' && url === '/api/detect') {
        // 保存用户填写的路径（记住）：空值 = 清除该项恢复自动检测
        const body = await readJsonBody(req);
        try {
          let merged: Record<string, unknown> = {};
          if (fs.existsSync(USER_CONFIG)) {
            try {
              merged = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf-8')) as Record<string, unknown>;
            } catch {
              merged = {};
            }
          }
          const setSec = (sec: string, key: string, v: unknown): void => {
            const section = (merged[sec] as Record<string, unknown>) || {};
            section[key] = v;
            merged[sec] = section;
          };
          const delSec = (sec: string, key: string): void => {
            const section = (merged[sec] as Record<string, unknown>) || {};
            delete section[key];
            merged[sec] = section;
          };
          const setOrDel = (sec: string, key: string, v: unknown): void => {
            if (v === undefined || v === null || String(v).trim() === '') delSec(sec, key);
            else setSec(sec, key, String(v).trim());
          };
          setOrDel('cursor', 'exe', body['cursorExe']);
          setOrDel('login_assistant', 'exe', body['assistantExe']);
          setOrDel('login_assistant', 'refresh_template', body['refreshTemplate']);
          setOrDel('login_assistant', 'confirm_template', body['confirmTemplate']);
          fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
          fs.writeFileSync(USER_CONFIG, JSON.stringify(merged, null, 2), 'utf-8');
          const project = getCfg().projectDir;
          currentCfg = cfgFor(project);
          logLine(`[web] /api/detect 已保存路径到 ${USER_CONFIG} 并热重载`);
          sendJson(res, 200, detectReport(getCfg()));
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
        return;
      }
      if (req.method === 'POST' && url === '/api/config') {
        // 运行参数持久化：写入 %APPDATA%\curloop\config.json 并热重载（模式固定 live，不收）
        const body = await readJsonBody(req);
        const updates: {
          maxTasks?: number;
          maxSwitches?: number;
          rotateEveryTasks?: number;
          checkpointEveryTasks?: number;
          finalVerify?: boolean;
        } = {};
        if (body['maxTasks'] !== undefined) updates.maxTasks = Math.max(0, Math.trunc(Number(body['maxTasks'])));
        if (body['maxSwitches'] !== undefined) updates.maxSwitches = Math.max(0, Math.trunc(Number(body['maxSwitches'])));
        if (body['rotateEveryTasks'] !== undefined) updates.rotateEveryTasks = Math.max(0, Math.trunc(Number(body['rotateEveryTasks'])));
        if (body['checkpointEveryTasks'] !== undefined) updates.checkpointEveryTasks = Math.max(0, Math.trunc(Number(body['checkpointEveryTasks'])));
        if (body['finalVerify'] !== undefined) updates.finalVerify = Boolean(body['finalVerify']);
        const r = applyConfigUpdate(updates);
        if (!r.ok) {
          sendJson(res, 500, { ok: false, error: r.error });
          return;
        }
        sendJson(res, 200, { ok: true, config: getCfg() });
        return;
      }
      if (req.method === 'POST' && url === '/api/init') {
        const body = await readJsonBody(req);
        const project = body['project'] ? path.resolve(String(body['project'])) : cfg.projectDir;
        const force = Boolean(body['force']);
        const created: string[] = [];
        const goal = String(body['goal'] ?? '').trim();
        const goalP = path.join(project, 'FinalGoal.md');
        fs.mkdirSync(project, { recursive: true });
        if (goal && (!fs.existsSync(goalP) || force)) {
          const content =
            '# 最终目标（FinalGoal）\n\n' +
            '> 由 curloop web 初始化生成；本文件是仓库的最高级规划。\n\n' +
            '## 最终目标\n\n' +
            `${goal}\n\n` +
            '## 硬门槛 / 交付物\n\n' +
            '- [ ] （待补充，后续规划会对照本目标生成 TODO）\n';
          fs.writeFileSync(goalP, content, 'utf-8');
          created.push(goalP);
        } else if (!goal && (!fs.existsSync(goalP) || force)) {
          fs.writeFileSync(goalP, INIT_GOAL, 'utf-8');
          created.push(goalP);
        }
        const todoP = path.join(project, 'TODO.md');
        if (!fs.existsSync(todoP) || force) {
          fs.writeFileSync(todoP, INIT_TODO, 'utf-8');
          created.push(todoP);
        }
        sendJson(res, 200, { ok: true, created, existed: { FinalGoal: fs.existsSync(goalP), TODO: fs.existsSync(todoP) } });
        return;
      }
      if (req.method === 'GET' && url === '/api/prompts') {
        // 提示词清单：内置模板 + 用户覆盖状态（%APPDATA%\curloop\prompts\<key>.txt）
        const items = PROMPT_DEFS.map((d) => {
          const overridePath = promptOverridePath(d.key);
          const source = promptSource(d.key);
          let content = d.template;
          let saved: string | null = null;
          if (source === 'override') {
            try {
              saved = fs.readFileSync(overridePath, 'utf-8');
              content = saved;
            } catch {
              saved = null;
            }
          }
          return { key: d.key, label: d.label, description: d.description, location: d.location, placeholders: d.placeholders, source, overridePath, saved, content };
        });
        sendJson(res, 200, { ok: true, dir: PROMPT_OVERRIDE_DIR, items });
        return;
      }
      if (req.method === 'POST' && url === '/api/prompts') {
        // 保存单个提示词覆盖：body { key, content }；content 为空 = 恢复内置（删除覆盖文件）
        const body = await readJsonBody(req);
        const key = String(body['key'] ?? '').trim();
        const def = PROMPT_DEFS.find((d) => d.key === key);
        if (!def) {
          sendJson(res, 400, { ok: false, error: `未知提示词 key: ${key}` });
          return;
        }
        const p = promptOverridePath(key);
        const content = String(body['content'] ?? '');
        try {
          if (!content.trim()) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } else {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content, 'utf-8');
          }
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e) });
          return;
        }
        logLine(`[web] /api/prompts 已保存 ${key} -> ${p}${content.trim() ? '' : '（已恢复内置）'}`);
        sendJson(res, 200, { ok: true, key, overridePath: p, source: promptSource(key) });
        return;
      }
      if (req.method === 'POST' && url === '/api/prompts/reset') {
        // 恢复全部/单个内置：body { key? }；不带 key = 全部重置
        const body = await readJsonBody(req);
        const only = String(body['key'] ?? '').trim();
        const keys = only ? [only] : PROMPT_DEFS.map((d) => d.key);
        const removed: string[] = [];
        for (const k of keys) {
          const p = promptOverridePath(k);
          try {
            if (fs.existsSync(p)) {
              fs.unlinkSync(p);
              removed.push(k);
            }
          } catch {
            /* ignore */
          }
        }
        logLine(`[web] /api/prompts/reset 已恢复内置: ${removed.join(', ') || '（无覆盖）'}`);
        sendJson(res, 200, { ok: true, removed });
        return;
      }
      sendJson(res, 404, { ok: false, error: `not found: ${url}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e) });
    }
  };
}

function openBrowser(url: string): void {
  try {
    cp.spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* ignore */
  }
}

export async function webMain(args: WebArgs): Promise<number> {
  const port = Number(args.port ?? DEFAULT_PORT);
  const cfg = cfgFor(args.project || process.cwd());
  if (args.mode) cfg.mode = String(args.mode);
  currentCfg = cfg; // 路由读取该引用；/api/config 保存后热重载

  console.log(`[web] curloop Web UI 数据源: project=${cfg.projectDir} stateDir=${cfg.stateDir}`);
  console.log(`[web] 管理员: ${isAdmin() ? '是（live/limit-sim 可用）' : '否（仅 dry-run 与只读操作；live/limit-sim 请用管理员终端启动本服务）'}`);
  logLine(`[web] 服务器启动，project=${cfg.projectDir}，mode=${cfg.mode}`);

  // 端口被占时自动顺延（EADDRINUSE → +1，最多 10 次）
  let chosenPort = port;
  const server = http.createServer(router());
  const listen = (p: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', (e) => {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EADDRINUSE' && p < port + 10) {
          logLine(`[web] 端口 ${p} 被占用，顺延到 ${p + 1}`);
          resolve(p + 1);
        } else {
          reject(e);
        }
      });
      server.listen(p, '127.0.0.1', () => resolve(p));
    });

  try {
    chosenPort = await listen(port);
    if (chosenPort !== port) chosenPort = await listen(chosenPort);
  } catch (e) {
    console.error(`[web] 端口 ${port} 启动失败: ${(e as Error).message}`);
    console.error(`[web] 可换端口: curloop web --port 8080`);
    process.exitCode = 1;
    return 1;
  }
  const url = `http://127.0.0.1:${chosenPort}`;
  console.log(`[web] 打开: ${url} （Ctrl-C 停止服务；运行中的任务会先写 STOP 优雅退出）`);
  if (!args['no-open']) openBrowser(url);

  const shutdown = (): void => {
    console.log('\n[web] 停止服务…');
    if (activeChild) {
      console.log('[web] 正在优雅停止运行中的任务（写 STOP，最多等 3 秒）…');
      stopChild();
      // 注意：不能在 process.exit 前只关 server —— 必须先处理子进程，
      // 否则 4 秒后的强杀定时器永远不会执行，子进程变孤儿。
      setTimeout(() => {
        try {
          if (activeChild && activeChild.proc.exitCode === null) {
            console.log('[web] 子进程未退出，强杀…');
            activeChild.proc.kill();
          }
        } catch {
          /* ignore */
        }
        try {
          server.close();
        } catch {
          /* ignore */
        }
        process.exit(0);
      }, 3500);
    } else {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // 保持进程存活（server 已 keep-alive；这里返回一个永不 resolve 的 Promise）
  return new Promise<number>(() => {
    /* run forever until Ctrl-C */
  });
}
