import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as win32 from './win32';
import { locateTemplateOnPng } from './template';
import { sleep } from './cdp';
import type { Config } from './config';

/**
 * GUI 自动化 for 换号助手（CursorLoginAssistant-836.exe）。
 *
 * 主路径：PowerShell 桥截图 → 纯 TS 模板匹配（降采样 NCC）定位
 * refresh_cursor.png / confirm_ok.png → SendInput 点击。与 Python 版
 * pyautogui 模板匹配语义对齐（CCOEFF_NORMED 置信度）。
 *
 * `dryRun=true` 只定位窗口/模板，绝不点击、不启动新进程。
 */

const ASSISTANT_TITLE_FRAGMENTS = ['Cursor 登录助手', '登录助手', 'CursorLoginAssistant'];

function isRunning(exeName: string): Promise<boolean> {
  // tasklist /NH truncates image names to 25 chars → match the stem
  const stem = path.parse(exeName).name.toLowerCase();
  return new Promise((resolve) => {
    cp.exec(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, { encoding: 'utf8' }, (_err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.toLowerCase();
      resolve(stem.length > 0 && out.includes(stem));
    });
  });
}

function findWindowsByTitle(fragment: string): Promise<number[]> {
  return win32.listWindows().then((wins) =>
    wins.filter((w) => w.title.toLowerCase().includes(fragment.toLowerCase())).map((w) => w.hwnd),
  );
}

async function findWindowsForExe(exePath: string): Promise<number[]> {
  const stem = path.parse(exePath).name.toLowerCase();
  const wins = await win32.listWindows();
  return wins.filter((w) => w.exe.toLowerCase().includes(stem)).map((w) => w.hwnd);
}

async function assistantLikeTitles(): Promise<string[]> {
  const hints = ['cursor', '登录', '助手', 'assistant', 'login', '换号'];
  const wins = await win32.listWindows();
  const out: string[] = [];
  for (const w of wins) {
    const low = w.title.toLowerCase();
    if (hints.some((h) => low.includes(h))) out.push(w.title);
  }
  return out;
}

function isOnPrimary(x: number, y: number, w: number, h: number, sw: number, sh: number): boolean {
  return !(x >= sw || x + w <= 0 || y >= sh || y + h <= 0);
}

async function moveToPrimaryAndForeground(hwnd: number): Promise<void> {
  await win32.showRestore(hwnd); // SW_RESTORE — 必须先还原再移动
  await sleep(0.3);
  const rect = await win32.windowRect(hwnd);
  const { w: sw, h: sh } = await win32.screenSize();
  if (rect) {
    const [x, y, w, h] = rect;
    if (!isOnPrimary(x, y, w, h, sw, sh)) {
      await win32.moveWindow(hwnd, 100, 100, w, h); // SWP_SHOWWINDOW
      await sleep(0.4);
    }
  }
  await win32.setTopmost(hwnd, true); // 防最大化/全屏终端遮挡
  await sleep(0.5); // 置顶后等重绘
  await win32.foreground(hwnd);
}

export interface TemplateLocateResult {
  ok: boolean;
  box?: [number, number, number, number];
  center?: [number, number];
  confidence?: number;
  grayscale?: boolean;
  score?: number;
  clicked?: boolean;
  reason?: string;
}

/**
 * 截图并定位模板。返回（映射回原始屏幕坐标的）模板位置。
 * 与 pyautogui.locateOnScreen 的轮询语义一致：截屏 + 匹配，找不到则 sleep 重试。
 */
export async function locateTemplate(
  templateFile: string,
  confidence: number,
  timeoutS: number,
  poll = 1.0,
): Promise<TemplateLocateResult> {
  await win32.dpiAware();
  if (!fs.existsSync(templateFile)) {
    return { ok: false, reason: `template not found on disk: ${templateFile}` };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curloop-cap-'));
  const capFile = path.join(tmpDir, 'screen.png');
  const deadline = Date.now() + timeoutS * 1000;
  try {
    while (Date.now() < deadline) {
      // 多个置信度尝试（对齐 pyautogui: confidence 与 confidence-0.05 兜底）
      for (const conf of [confidence, Math.max(0.7, confidence - 0.05)]) {
        try {
          await win32.capturePrimary(capFile);
          const m = locateTemplateOnPng(capFile, templateFile, 4);
          if (m.ok && m.score !== undefined && m.score >= conf - 0.02) {
            return {
              ok: true,
              box: m.box ? [m.box.left, m.box.top, m.box.width, m.box.height] : undefined,
              center: m.center,
              confidence: conf,
              grayscale: true,
              score: m.score,
            };
          }
        } catch {
          /* capture failed — retry */
        }
      }
      await sleep(poll);
    }
    return { ok: false, reason: 'template not found on screen' };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function findAssistantWindow(exePath: string, timeoutS: number): Promise<[number | null, string[]]> {
  const deadline = Date.now() + timeoutS * 1000;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    let wins = await findWindowsForExe(exePath);
    if (wins.length) return [wins[0], seen];
    for (const frag of ASSISTANT_TITLE_FRAGMENTS) {
      wins = await findWindowsByTitle(frag);
      if (wins.length) return [wins[0], seen];
    }
    if (!seen.length) seen = await assistantLikeTitles();
    await sleep(2);
  }
  return [null, seen];
}

async function closeAssistant(exePath: string, timeoutS = 5.0): Promise<Record<string, unknown>> {
  const exeName = path.basename(exePath);
  const wins = await findWindowsForExe(exePath);
  let sent = 0;
  for (const hwnd of wins) {
    await win32.postClose(hwnd); // WM_CLOSE
    sent += 1;
  }
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline && (await isRunning(exeName))) {
    await sleep(0.5);
  }
  let forceKilled = false;
  if (await isRunning(exeName)) {
    await killProcessByName(exeName);
    await sleep(1.0);
    forceKilled = true;
  }
  return { ok: !(await isRunning(exeName)), wmCloseSent: sent, forceKilled };
}

export function killProcessByName(exeName: string): Promise<void> {
  return new Promise((resolve) => {
    const ps = `Get-CimInstance Win32_Process -Filter "Name = '${exeName}'" | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
`;
    cp.exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '""')}"`, { encoding: 'utf8' }, () => resolve());
  });
}

async function restartAssistant(cfg: Config): Promise<Record<string, unknown>> {
  const la = cfg.loginAssistant;
  await closeAssistant(la.exe);
  await sleep(1.0);
  try {
    cp.spawn(la.exe, [], { stdio: 'ignore', detached: true, windowsHide: true });
  } catch (e) {
    return { ok: false, reason: `relaunch: ${String(e)}` };
  }
  const deadline = Date.now() + la.launchWaitS * 1000;
  while (Date.now() < deadline) {
    const wins = await findWindowsForExe(la.exe);
    if (wins.length) {
      await moveToPrimaryAndForeground(wins[0]);
      return { ok: true, hwnd: wins[0], relaunched: true };
    }
    await sleep(2);
  }
  return { ok: false, reason: 'window not found after relaunch' };
}

export interface RefreshReport {
  ok: boolean;
  steps: Record<string, unknown>[];
  error?: string;
}

/**
 * 启动（如需）换号助手 → 移到主屏 → 点 刷新Cursor → 关确认框。
 * Token 变化检测由调用方负责（loop），这里不做。
 */
export async function refreshAccount(cfg: Config, dryRun = false): Promise<RefreshReport> {
  await win32.dpiAware();
  const la = cfg.loginAssistant;
  const result: RefreshReport = { ok: false, steps: [] };
  const exeName = path.basename(la.exe);

  // 1. 确保进程在运行
  let launched = false;
  let launchError: string | null = null;
  let proc: cp.ChildProcess | null = null;
  if (!(await isRunning(exeName))) {
    if (dryRun) {
      result.steps.push({ step: 'launch', ok: false, wouldLaunch: true });
      result.steps.push({ step: 'window', ok: false, reason: "assistant not running (dry-run won't launch)" });
      return result;
    }
    try {
      proc = cp.spawn(la.exe, [], { stdio: 'ignore', detached: true, windowsHide: true });
      launched = true;
    } catch (e) {
      launchError = String(e);
    }
  }
  const deadline = Date.now() + (launched ? la.launchWaitS : 3.0) * 1000;
  let up = await isRunning(exeName);
  let exitedEarly: number | null = null;
  while (!up && Date.now() < deadline) {
    await sleep(2);
    up = await isRunning(exeName);
    if (proc && proc.exitCode !== null && exitedEarly === null) exitedEarly = proc.exitCode;
  }
  if (launchError) {
    result.steps.push({ step: 'launch', ok: false, launched: false, error: launchError });
    return result;
  }
  result.steps.push({ step: 'launch', ok: up, launched, waitS: la.launchWaitS, exitedEarly });
  if (!up) {
    result.steps.push({ step: 'window', ok: false, reason: 'assistant process did not start' });
    return result;
  }

  // 2. 找窗口（标题中文 “Cursor 登录助手”）
  let hwnd: number | null = null;
  let seenTitles: string[] = [];
  if (!dryRun) {
    [hwnd, seenTitles] = await findAssistantWindow(la.exe, la.launchWaitS);
  } else {
    const wins = await findWindowsForExe(la.exe);
    hwnd = wins[0] || null;
    if (!hwnd) {
      const byTitle = await findWindowsByTitle('登录助手');
      hwnd = byTitle[0] || null;
    }
    if (!hwnd) seenTitles = await assistantLikeTitles();
  }
  if (!hwnd) {
    result.steps.push({
      step: 'window',
      ok: false,
      reason: 'assistant window not found',
      processRunning: await isRunning(exeName),
      visibleAssistantLikeTitles: seenTitles,
    });
    return result;
  }
  result.steps.push({ step: 'window', ok: true, hwnd });
  if (!dryRun) await moveToPrimaryAndForeground(hwnd);

  // 3. 点 刷新Cursor
  let refresh: TemplateLocateResult = { ok: false, reason: 'no refresh template configured' };
  if (la.refreshTemplate && fs.existsSync(la.refreshTemplate)) {
    refresh = await locateTemplate(la.refreshTemplate, la.confidence, la.confirmWaitS, 0.5);
    if (refresh.ok && !dryRun) {
      await win32.clickAt(refresh.center![0], refresh.center![1]);
      refresh.clicked = true;
    }
  }
  if (!refresh.ok && !dryRun) {
    // 窗口被隐藏到托盘/最小化：模板找不到 → 重启助手重试
    const rp = await restartAssistant(cfg);
    result.steps.push({ step: 'restart', ...rp });
    if (rp.ok && la.refreshTemplate && fs.existsSync(la.refreshTemplate)) {
      hwnd = rp['hwnd'] as number;
      refresh = await locateTemplate(la.refreshTemplate, la.confidence, la.confirmWaitS, 0.5);
      if (refresh.ok) {
        await win32.clickAt(refresh.center![0], refresh.center![1]);
        refresh.clicked = true;
      }
    }
  }
  result.steps.push({ step: 'refresh', ...refresh });

  // 4. 确认框（独立顶层 QDialog）
  if (!dryRun) {
    await sleep(1.5);
    try {
      const wins = await findWindowsForExe(la.exe);
      for (const w of wins) await win32.setTopmost(w, true);
    } catch {
      /* ignore */
    }
  }
  let confirm: TemplateLocateResult = { ok: false, reason: 'no confirm template configured' };
  if (la.confirmTemplate && fs.existsSync(la.confirmTemplate)) {
    confirm = await locateTemplate(la.confirmTemplate, la.confidence, la.confirmWaitS, 0.5);
    if (confirm.ok && !dryRun) {
      await win32.clickAt(confirm.center![0], confirm.center![1]);
      confirm.clicked = true;
    }
  }
  result.steps.push({ step: 'confirm', ...confirm });

  result.ok = Boolean(refresh.ok);

  // 5. 关闭助手（WM_CLOSE 优先，强杀兜底），除非配置关闭
  if (la.closeAfterRefresh && !dryRun) {
    const closed = await closeAssistant(la.exe);
    result.steps.push({ step: 'close', ...closed });
  } else if (!dryRun && hwnd) {
    // 常驻时不解除置顶会一直盖着屏幕；换号动作已完成，解除置顶安全
    try {
      await win32.setTopmost(hwnd, false);
    } catch {
      /* ignore */
    }
  }
  return result;
}
