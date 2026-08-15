import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { load as loadConfig, Config, USER_CONFIG } from './config';
import { buildStatus, loadEvents, loadSnapshot } from './observer';
import { isAdmin, stopFilePath } from './loop';
import { INIT_GOAL, INIT_TODO } from './cli';
import * as cursor from './cursor';

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
function spawnTool(cfg: Config, kind: 'run' | 'plan', extra: string[]): { ok: boolean; error?: string } {
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

/** 更新用户配置：把分节参数合并进 %APPDATA%\curloop\config.json 并热重载。 */
function applyConfigUpdate(updates: {
  mode?: string;
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
    if (updates.mode !== undefined) merged['mode'] = updates.mode;
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
      if (req.method === 'GET' && url === '/api/snapshot') {
        sendJson(res, 200, { ok: true, snapshot: loadSnapshot(cfg.projectDir, cfg.stateDir) });
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
        const mode = String(body['mode'] ?? cfg.mode);
        const project = body['project'] ? path.resolve(String(body['project'])) : cfg.projectDir;
        if (activeChild) {
          sendJson(res, 409, { ok: false, error: '已有任务在运行' });
          return;
        }
        if ((mode === 'live' || mode === 'limit-sim') && !isAdmin()) {
          sendJson(res, 403, { ok: false, error: 'live / limit-sim 需要管理员权限（请用管理员终端启动 curloop web）' });
          return;
        }
        const runCfg = cfgFor(project);
        runCfg.mode = mode;
        const extra: string[] = ['--mode', mode];
        const mt = Number(body['maxTasks'] ?? 0);
        if (mt > 0) extra.push('--max-tasks', String(mt));
        const ms = Number(body['maxSwitches'] ?? 0);
        if (ms > 0) extra.push('--max-switches', String(ms));
        const r = spawnTool(runCfg, 'run', extra);
        sendJson(res, r.ok ? 200 : 500, r);
        return;
      }
      if (req.method === 'POST' && url === '/api/plan') {
        const body = await readJsonBody(req);
        const project = body['project'] ? path.resolve(String(body['project'])) : cfg.projectDir;
        const runCfg = cfgFor(project);
        const r = spawnTool(runCfg, 'plan', []);
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
        // 人在回路：手动向 Cursor 发送一条消息（调试/介入）。需要 Cursor 带 CDP 运行。
        const body = await readJsonBody(req);
        const prompt = String(body['prompt'] ?? '').trim();
        if (!prompt) {
          sendJson(res, 400, { ok: false, error: 'prompt 为空' });
          return;
        }
        const project = body['project'] ? path.resolve(String(body['project'])) : cfg.projectDir;
        const askCfg = cfgFor(project);
        cursor.init(askCfg);
        if (!(await cursor.cdpUp(askCfg.cursor.port))) {
          sendJson(res, 409, { ok: false, error: 'CDP 未就绪（Cursor 未带调试端口运行）' });
          return;
        }
        const sr = await cursor.sendPrompt(askCfg, prompt, true);
        logLine(`[web] /api/ask -> ${sr['ok'] ? '已发送' : '失败: ' + String(sr['error'] ?? JSON.stringify(sr['type'] ?? ''))}`);
        sendJson(res, sr['ok'] ? 200 : 500, { ok: Boolean(sr['ok']), detail: sr });
        return;
      }
      if (req.method === 'POST' && url === '/api/config') {
        // 运行参数持久化：写入 %APPDATA%\curloop\config.json 并热重载
        const body = await readJsonBody(req);
        const updates: {
          mode?: string;
          maxTasks?: number;
          maxSwitches?: number;
          rotateEveryTasks?: number;
          checkpointEveryTasks?: number;
          finalVerify?: boolean;
        } = {};
        if (body['mode'] !== undefined) updates.mode = String(body['mode']);
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
        const created: string[] = [];
        const goal = String(body['goal'] ?? '').trim();
        const goalP = path.join(project, 'FinalGoal.md');
        if (goal && !fs.existsSync(goalP)) {
          const content =
            '# 最终目标（FinalGoal）\n\n' +
            '> 由 curloop web 初始化生成；本文件是仓库的最高级规划。\n\n' +
            '## 最终目标\n\n' +
            `${goal}\n\n` +
            '## 硬门槛 / 交付物\n\n' +
            '- [ ] （待补充，后续规划会对照本目标生成 TODO）\n';
          fs.writeFileSync(goalP, content, 'utf-8');
          created.push(goalP);
        } else if (!goal) {
          if (!fs.existsSync(goalP)) {
            fs.writeFileSync(goalP, INIT_GOAL, 'utf-8');
            created.push(goalP);
          }
        }
        const todoP = path.join(project, 'TODO.md');
        if (!fs.existsSync(todoP)) {
          fs.writeFileSync(todoP, INIT_TODO, 'utf-8');
          created.push(todoP);
        }
        sendJson(res, 200, { ok: true, created, existed: { FinalGoal: fs.existsSync(goalP), TODO: fs.existsSync(todoP) } });
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
