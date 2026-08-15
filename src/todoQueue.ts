import * as fs from 'fs';
import * as path from 'path';
import { withSyncLock } from './fileLock';

/**
 * TODO.md checkbox parsing -> ordered task queue, mark-done writer.
 *
 * Parses markdown checkboxes (`- [ ]`, `- [x]`, `- [X]`, `- [-]`), supports CRLF,
 * indentation and bullets `-`/`*`/`+`. Generates the prompt fed to Cursor and
 * flips a finished item back to `[x]` by normalized text match (not frozen line
 * number), preserving original line endings.
 *
 * `[-]` is treated as cancelled (done=true, not queued). Duplicate normalized
 * texts are skipped with a stderr warning.
 */

export const CHECKBOX_RE =
  /^(?<indent>\s*)(?<bullet>[-*+])\s+\[(?<state>[ xX\-])\]\s+(?<text>.+?)\s*$/;

export type EnsureDoneResult = 'changed' | 'already' | 'missing';

export function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function todoLockPath(todoFile: string): string {
  return path.join(path.dirname(todoFile), path.basename(todoFile) + '.lock');
}

export class TodoTask {
  text: string;
  line: number; // 1-based line number in TODO.md
  indent: string;
  bullet: string;
  done: boolean;
  index: number;
  status: string; // pending | running | done | skipped
  retries: number;
  switchReason: string | null;

  constructor(opts: {
    text: string;
    line: number;
    indent?: string;
    bullet?: string;
    done?: boolean;
    index?: number;
    status?: string;
    retries?: number;
    switchReason?: string | null;
  }) {
    this.text = opts.text;
    this.line = opts.line;
    this.indent = opts.indent ?? '';
    this.bullet = opts.bullet ?? '-';
    this.done = opts.done ?? false;
    this.index = opts.index ?? 0;
    this.status = opts.status ?? 'pending';
    this.retries = opts.retries ?? 0;
    this.switchReason = opts.switchReason ?? null;
  }

  normalized(): string {
    return norm(this.text);
  }

  prompt(projectDir: string): string {
    return (
      `项目：${projectDir}\n` +
      `请完成 TODO：${this.text}\n` +
      `（接手现有工作继续做，直到任务真正完成；中途不要停。\n` +
      `完成后请 git add -A 并 git commit 提交你的改动，commit message 简要描述本任务。\n` +
      `完成本任务的过程中，如果实际进展表明还有值得继续的下一步（如新发现的问题、` +
      `拆出的子任务、下一步实现计划），请按 \`- [ ] 任务描述\` 格式追加到 TODO.md 末尾` +
      `（每行一项、只追加确有必要的，不要重复已有任务；没有就跳过这一条），` +
      `无人值守循环会读取 TODO.md 自动继续执行新任务。）`
    );
  }

  toDict(): Record<string, unknown> {
    return {
      text: this.text,
      line: this.line,
      indent: this.indent,
      bullet: this.bullet,
      done: this.done,
      index: this.index,
      status: this.status,
      retries: this.retries,
      switch_reason: this.switchReason,
    };
  }

  static fromDict(d: Record<string, unknown>): TodoTask {
    const t = new TodoTask({
      text: String(d['text']),
      line: Number(d['line']),
      indent: String(d['indent'] ?? ''),
      bullet: String(d['bullet'] ?? '-'),
      done: Boolean(d['done']),
      index: Number(d['index'] ?? 0),
    });
    t.status = String(d['status'] ?? 'pending');
    t.retries = Number(d['retries'] ?? 0);
    const sr = d['switch_reason'];
    t.switchReason = sr === null || sr === undefined ? null : String(sr);
    return t;
  }
}

/** Parse every checkbox in TODO.md (checked and unchecked), file order. */
export function parseAll(todoFile: string): TodoTask[] {
  if (!fs.existsSync(todoFile)) return [];
  const text = fs.readFileSync(todoFile, 'utf-8');
  // Normalize CRLF so offsets are predictable regardless of line endings.
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const tasks: TodoTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    const groups = m.groups as { indent: string; bullet: string; state: string; text: string };
    const taskText = groups.text.trim();
    const n = norm(taskText);
    if (seen.has(n)) {
      console.error(`[warn] TODO 重复文案已跳过（保留首次）: ${taskText.slice(0, 60)}`);
      continue;
    }
    seen.add(n);
    const state = groups.state.toLowerCase();
    tasks.push(
      new TodoTask({
        text: taskText,
        line: i + 1,
        indent: groups.indent,
        bullet: groups.bullet,
        done: state === 'x' || state === '-', // [-] = cancelled
        index: tasks.length,
      }),
    );
  }
  return tasks;
}

/** Ensure the matching checkbox is `[x]`. Returns 'changed' | 'already' | 'missing'. */
export function ensureDone(todoFile: string, text: string): EnsureDoneResult {
  const target = norm(text);
  if (!target) return 'missing';
  const clean = text.trim();
  fs.mkdirSync(path.dirname(todoFile), { recursive: true });
  return withSyncLock(
    todoLockPath(todoFile),
    () => {
      if (!fs.existsSync(todoFile)) {
        fs.writeFileSync(todoFile, `- [x] ${clean}\n`, 'utf-8');
        return 'missing' as EnsureDoneResult;
      }
      const raw = fs.readFileSync(todoFile);
      const crlf = raw.includes(Buffer.from('\r\n', 'ascii'));
      const sep = crlf ? '\r\n' : '\n';
      const body = raw.toString('utf-8');
      const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = CHECKBOX_RE.exec(lines[i]);
        if (!m) continue;
        const groups = m.groups as { indent: string; bullet: string; state: string; text: string };
        if (norm(groups.text) !== target) continue;
        const state = groups.state.toLowerCase();
        if (state === 'x' || state === '-') return 'already' as EnsureDoneResult;
        lines[i] = `${groups.indent}${groups.bullet} [x] ${groups.text}`;
        fs.writeFileSync(todoFile, lines.join(sep), 'utf-8');
        return 'changed' as EnsureDoneResult;
      }
      // No match: append done checkbox.
      const prefix = !raw.length || raw[raw.length - 1] === 0x0a ? '' : sep;
      fs.writeFileSync(todoFile, raw.toString('utf-8') + prefix + `- [x] ${clean}` + sep, 'utf-8');
      return 'missing' as EnsureDoneResult;
    },
    30.0,
  );
}

/** Flip unchecked checkbox to `[x]`. True if changed (not already/missing). */
export function markDone(todoFile: string, text: string): boolean {
  return ensureDone(todoFile, text) === 'changed';
}
