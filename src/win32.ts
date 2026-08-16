import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Win32 自动化桥：包装 src/win32.ps1（Add-Type 编译 C# 实现窗口/截图/点击）。
 * 零原生 npm 依赖——所有 Win32 调用都经 PowerShell 完成。
 */

// 优先 dist 内副本（npm run build 会拷贝）；开发目录未拷贝时回退到 src/
const WIN32_PS1_CANDIDATES = [
  path.join(__dirname, 'win32.ps1'),
  path.join(__dirname, '..', 'src', 'win32.ps1'),
];
export const WIN32_PS1: string =
  WIN32_PS1_CANDIDATES.find((p) => fs.existsSync(p)) || WIN32_PS1_CANDIDATES[1];

export interface WinInfo {
  hwnd: number;
  pid: number;
  title: string;
  exe: string;
  rect: [number, number, number, number]; // [left, top, width, height]
}

function runPs(psArgs: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        WIN32_PS1,
        ...psArgs,
      ],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`win32.ps1 ${psArgs[0]} failed (${code}): ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function listWindows(): Promise<WinInfo[]> {
  const v = (await runPs(['list-windows'])) as Array<Record<string, unknown>> | null;
  return (v || []).map((w) => ({
    hwnd: Number(w['hwnd']),
    pid: Number(w['pid']),
    title: String(w['title'] || ''),
    exe: String(w['exe'] || ''),
    rect: (w['rect'] as [number, number, number, number]) || [0, 0, 0, 0],
  }));
}

export async function windowRect(hwnd: number): Promise<[number, number, number, number] | null> {
  const v = (await runPs(['window-rect', String(hwnd)])) as number[] | null;
  return v ? (v as [number, number, number, number]) : null;
}

export async function setTopmost(hwnd: number, topmost: boolean): Promise<boolean> {
  return (await runPs(['set-topmost', String(hwnd), topmost ? '1' : '0'])) === true;
}

export async function moveWindow(hwnd: number, x: number, y: number, w: number, h: number): Promise<boolean> {
  return (await runPs(['move-window', String(hwnd), String(x), String(y), String(w), String(h)])) === true;
}

export async function showRestore(hwnd: number): Promise<boolean> {
  return (await runPs(['show-restore', String(hwnd)])) === true;
}

export async function foreground(hwnd: number): Promise<boolean> {
  return (await runPs(['foreground', String(hwnd)])) === true;
}

export async function postClose(hwnd: number): Promise<boolean> {
  return (await runPs(['post-close', String(hwnd)])) === true;
}

export async function screenSize(): Promise<{ w: number; h: number }> {
  const v = (await runPs(['screen-size'])) as { w?: number; h?: number } | null;
  return { w: Number(v?.w || 0), h: Number(v?.h || 0) };
}

export async function capturePrimary(outFile: string): Promise<string> {
  const v = (await runPs(['capture-primary', outFile])) as { ok?: boolean; file?: string } | null;
  if (!v?.ok) throw new Error(`capture failed: ${JSON.stringify(v)}`);
  return v.file as string;
}

export async function clickAt(x: number, y: number): Promise<boolean> {
  return (await runPs(['click', String(Math.round(x)), String(Math.round(y))])) === true;
}

export interface ClickDiagResult {
  ok: boolean;
  before: [number, number];
  after: [number, number];
  screen: [number, number];
}

export async function clickDiag(x: number, y: number): Promise<ClickDiagResult | null> {
  const v = (await runPs(['click-diag', String(Math.round(x)), String(Math.round(y))])) as {
    ok?: boolean;
    before?: number[];
    after?: number[];
    screen?: number[];
  } | null;
  if (!v) return null;
  return {
    ok: Boolean(v.ok),
    before: [Number(v.before?.[0] || 0), Number(v.before?.[1] || 0)],
    after: [Number(v.after?.[0] || 0), Number(v.after?.[1] || 0)],
    screen: [Number(v.screen?.[0] || 0), Number(v.screen?.[1] || 0)],
  };
}

export async function cursorPos(): Promise<[number, number] | null> {
  const v = (await runPs(['cursor-pos'])) as number[] | null;
  return v ? [Number(v[0] || 0), Number(v[1] || 0)] : null;
}

export interface WindowAtPointInfo {
  hwnd: number;
  rect: [number, number, number, number];
  pid: number;
  title: string;
  exe: string;
}

export async function windowAtPoint(x: number, y: number): Promise<WindowAtPointInfo | null> {
  const v = (await runPs(['window-at-point', String(Math.round(x)), String(Math.round(y))])) as {
    hwnd?: number;
    rect?: number[];
    pid?: number;
    title?: string;
    exe?: string;
  } | null;
  if (!v) return null;
  return {
    hwnd: Number(v.hwnd || 0),
    rect: [(v.rect?.[0] || 0), (v.rect?.[1] || 0), (v.rect?.[2] || 0), (v.rect?.[3] || 0)],
    pid: Number(v.pid || 0),
    title: String(v.title || ''),
    exe: String(v.exe || ''),
  };
}

export async function isAdmin(): Promise<boolean> {
  return (await runPs(['is-admin'])) === true;
}

export async function dpiAware(): Promise<boolean> {
  return (await runPs(['dpi-aware'])) === true;
}
