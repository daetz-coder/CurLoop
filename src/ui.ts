/** 终端显示：ANSI 配色 + status/stats 渲染（零依赖）。
 *
 * Windows 下启用 VT 转义；非 TTY（管道/日志）自动降级为纯文本。
 */

let ansi = true;

/** Enable ANSI escape processing (Windows 10+); disable when not a TTY. */
export function init(): void {
  if (process.platform === 'win32') {
    try {
      // 启用 Windows 控制台的 VT 处理
      const cp = require('child_process');
      cp.execSync('', { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  ansi = process.stdout.isTTY === true;
}

export const C = {
  R: '\u001b[0m',
  B: '\u001b[1m',
  DIM: '\u001b[2m',
  RED: '\u001b[31m',
  GREEN: '\u001b[32m',
  YELLOW: '\u001b[33m',
  BLUE: '\u001b[34m',
  MAGENTA: '\u001b[35m',
  CYAN: '\u001b[36m',
  GRAY: '\u001b[90m',
};

export function paint(text: string, color = '', bold = false): string {
  if (!ansi || !color) return text;
  const code = color + (bold ? C.B : '');
  return `${code}${text}${C.R}`;
}

export function ok(text: string): string {
  return paint(text, C.GREEN);
}

export function warn(text: string): string {
  return paint(text, C.YELLOW);
}

export function err(text: string): string {
  return paint(text, C.RED);
}

export function head(text: string): string {
  return paint(text, C.CYAN, true);
}

export function num(text: string): string {
  return paint(text, C.MAGENTA, true);
}

export function dim(text: string): string {
  return paint(text, C.GRAY);
}

function line(char = '─', width = 60): string {
  return dim(char.repeat(width));
}

export interface UiQueueItem {
  text: string;
  status?: string;
}
export interface UiRecentItem {
  t: string;
  event: unknown;
  detail: string;
}

export function statusRender(d: {
  stats: StatusStatsLike;
  running?: string;
  now?: string;
  queue: UiQueueItem[];
  recent: UiRecentItem[];
}): string {
  const s = d.stats;
  const L: string[] = [];
  const add = (x: string) => L.push(x);
  add(head('╔═ CursorHarness · 观察状态 ') + dim('═'.repeat(24)) + head(' ═╗'));
  add(`  ${dim('项目')}   ${s.project || '-'}`);
  const mode = s.mode || '-';
  add(`  ${dim('模式')}   ${mode === 'live' ? ok(mode) : warn(mode)}    ${dim('已运行')} ${num(d.running || '-')}    ${dim('刷新')} ${d.now || '-'}`);
  add(line());
  add(`  ${head('换号')}  ${num(String(s.switches))}   ${ok('成功 ' + String(s.switch_ok))}   ${err('失败 ' + String(s.switch_failed))}`);
  if (s.emails && s.emails.length) {
    add(`  ${dim('账号')}   ${paint(s.emails.slice(-3).join(', '), C.CYAN)}`);
  }
  add(`  ${head('对话')}  ${num(String(s.sends))} 发送   ${ok(String(s.tasks_done))} 完成   ${paint(String(s.extend_ok), C.YELLOW)} 自动续接`);
  add(line());
  add(`  ${head('TODO 队列')}  ${dim('(' + String(d.queue.length) + ')')}`);
  if (!d.queue.length) {
    add(`  ${dim('   （空）')}`);
  }
  for (const q of d.queue) {
    const st = q.status;
    const markMap: Record<string, string> = {
      done: ok('✓ done'),
      running: warn('▶ running'),
      pending: dim('○ pending'),
      skipped: err('✗ skipped'),
    };
    const mark = markMap[st ?? ''] ?? dim(st ?? '');
    add(`   ${mark}  ${q.text.slice(0, 64)}`);
  }
  add(line());
  add(`  ${head('最近事件')}  ${dim('(最多 10 条)')}`);
  for (const e of d.recent.slice(0, 10)) {
    const ev = String(e.event ?? '');
    let evc: string;
    if (/fail|error/.test(ev)) evc = err(ev);
    else if (/done|ok/.test(ev)) evc = ok(ev);
    else if (/sent|start/.test(ev)) evc = paint(ev, C.CYAN);
    else evc = dim(ev);
    add(`   ${dim(e.t)}  ${evc.padEnd(24)} ${e.detail.slice(0, 44)}`);
  }
  add(head('╚' + '═'.repeat(58) + '╝'));
  return L.join('\n');
}

export interface StatusStatsLike {
  project?: string | null;
  mode?: string | null;
  switches?: number;
  switch_ok?: number;
  switch_failed?: number;
  emails?: string[];
  sends?: number;
  tasks_done?: number;
  extend_ok?: number;
}

export function statsRender(s: StatusStatsLike): string {
  const parts = [
    `${head('换号')} ${num(String(s.switches ?? 0))}`,
    `${ok(String(s.switch_ok ?? 0))} 成功 / ${err(String(s.switch_failed ?? 0))} 失败`,
    `${head('对话')} ${num(String(s.sends ?? 0))}`,
    `${head('完成')} ${ok(String(s.tasks_done ?? 0))}`,
    `${head('续接')} ${warn(String(s.extend_ok ?? 0))}`,
  ];
  let out = parts.join('  ');
  if (s.emails && s.emails.length) {
    out += `\n${dim('账号')}  ${paint(s.emails.join(', '), C.CYAN)}`;
  }
  return out;
}
