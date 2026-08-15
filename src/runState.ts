import * as fs from 'fs';
import * as path from 'path';
import { withSyncLock } from './fileLock';
import { TodoTask, parseAll } from './todoQueue';

/** Persistent run state: snapshot.json (crash resume) + events.jsonl (append log). */

// events.jsonl 超过此大小则轮转（当前 → .1 → .2 …），避免长跑无限膨胀。
const MAX_EVENT_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB
export const EVENT_LOG_KEEP = 3;

/** 若当前日志过大，轮转为 path.1 … path.N（覆盖最旧）。调用方须已持锁。 */
function rotateEventLog(p: string): void {
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size < MAX_EVENT_LOG_BYTES) return;
  } catch {
    return;
  }
  for (let i = EVENT_LOG_KEEP; i >= 1; i--) {
    const src = i === 1 ? p : path.join(path.dirname(p), `${path.basename(p)}.${i - 1}`);
    const dst = path.join(path.dirname(p), `${path.basename(p)}.${i}`);
    try {
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) fs.unlinkSync(dst);
      fs.renameSync(src, dst);
    } catch (e) {
      console.error(`[warn] event log rotate failed: ${String(e)}`);
      return;
    }
  }
}

/** 轮转段从旧到新：.N … .1，再当前文件。 */
export function eventLogPaths(p: string, keep = EVENT_LOG_KEEP): string[] {
  const paths: string[] = [];
  const dir = path.dirname(p);
  const base = path.basename(p);
  for (let i = keep; i >= 1; i--) {
    const rot = path.join(dir, `${base}.${i}`);
    if (fs.existsSync(rot)) paths.push(rot);
  }
  if (fs.existsSync(p)) paths.push(p);
  return paths;
}

export class RunState {
  snapshotFile: string;
  eventLogFile: string;
  queue: TodoTask[];
  switchesUsed = 0;
  cooldownUntil = 0.0;
  eventsWritten = 0;
  cdpBrowser: string | null = null;
  startedAt: number;

  constructor(snapshotFile: string, eventLogFile: string, queue: TodoTask[]) {
    this.snapshotFile = snapshotFile;
    this.eventLogFile = eventLogFile;
    this.queue = queue;
    this.startedAt = Date.now() / 1000;
  }

  get lockPath(): string {
    return path.join(path.dirname(this.snapshotFile), '.lock');
  }

  // ------------------------------------------------------------------ log
  log(event: string, fields: Record<string, unknown> = {}): void {
    const row: Record<string, unknown> = { ts: Date.now() / 1000, event, ...fields };
    fs.mkdirSync(path.dirname(this.eventLogFile), { recursive: true });
    try {
      withSyncLock(
        this.lockPath,
        () => {
          rotateEventLog(this.eventLogFile);
          fs.appendFileSync(this.eventLogFile, JSON.stringify(row) + '\n', 'utf-8');
        },
        10.0,
      );
      this.eventsWritten += 1;
    } catch (e) {
      // disk full / perms / lock timeout — never lose the run silently
      console.error(`[warn] event log append failed: ${String(e)}`);
    }
    const line = Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    console.log(`[${event}] ${line}`);
  }

  // ------------------------------------------------------------- snapshot
  save(): void {
    const snap: Record<string, unknown> = {
      version: 1,
      started_at: this.startedAt,
      switches_used: this.switchesUsed,
      cooldown_until: this.cooldownUntil,
      events_written: this.eventsWritten,
      cdp_browser: this.cdpBrowser,
      queue: this.queue.map((t) => t.toDict()),
    };
    fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
    const tmp = this.snapshotFile + '.tmp';
    const payload = JSON.stringify(snap, null, 2);
    try {
      withSyncLock(
        this.lockPath,
        () => {
          fs.writeFileSync(tmp, payload, 'utf-8');
          fs.renameSync(tmp, this.snapshotFile);
        },
        10.0,
      );
    } catch (e) {
      console.error(`[warn] snapshot lock failed: ${String(e)}`);
      // 仍尽力落盘，避免丢进度
      try {
        fs.writeFileSync(tmp, payload, 'utf-8');
        fs.renameSync(tmp, this.snapshotFile);
      } catch {
        /* ignore */
      }
    }
  }

  /** First pending task (in-flight 'running' is resumed as pending). */
  nextTask(): TodoTask | null {
    for (const t of this.queue) {
      if (t.status === 'pending' || t.status === 'running') {
        if (t.status === 'running') t.status = 'pending';
        return t;
      }
    }
    return null;
  }

  // --------------------------------------------------------------- resume
  static load(snapshotFile: string, eventLogFile: string, todoFile: string): RunState {
    const fresh = parseAll(todoFile);
    const freshUnchecked = fresh.filter((t) => !t.done);
    const freshDoneNorms = new Set(fresh.filter((t) => t.done).map((t) => t.normalized()));
    const freshUncheckedNorms = new Set(freshUnchecked.map((t) => t.normalized()));
    const freshByNorm = new Map(fresh.map((t) => [t.normalized(), t]));

    const st = new RunState(snapshotFile, eventLogFile, []);
    if (!fs.existsSync(snapshotFile)) {
      st.queue = freshUnchecked;
      return st;
    }

    let snap: Record<string, unknown>;
    try {
      snap = withSyncLock(
        path.join(path.dirname(snapshotFile), '.lock'),
        () => {
          try {
            return JSON.parse(fs.readFileSync(snapshotFile, 'utf-8')) as Record<string, unknown>;
          } catch {
            return {};
          }
        },
        10.0,
      );
    } catch {
      try {
        snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8')) as Record<string, unknown>;
      } catch {
        st.queue = freshUnchecked;
        return st;
      }
    }

    const snapTasks: TodoTask[] = ((snap['queue'] as Record<string, unknown>[]) || []).map((x) =>
      TodoTask.fromDict(x),
    );

    // Sync snapshot ↔ TODO.md: checked → done; user uncheck → pending again.
    for (const t of snapTasks) {
      const n = t.normalized();
      if (t.status !== 'done' && freshDoneNorms.has(n)) {
        t.status = 'done';
        t.done = true;
      } else if (t.status === 'done' && freshUncheckedNorms.has(n)) {
        t.status = 'pending';
        t.done = false;
      }
      // Refresh line/indent/bullet/index from current TODO.md so
      // markDone-by-text still works even if Agent inserted lines above.
      const f = freshByNorm.get(n);
      if (f) {
        t.line = f.line;
        t.indent = f.indent;
        t.bullet = f.bullet;
        t.index = f.index;
        t.text = f.text;
      }
    }

    const knownNorms = new Set(snapTasks.map((t) => t.normalized()));

    // Append brand-new unchecked items the user added since the snapshot.
    for (const t of freshUnchecked) {
      if (!knownNorms.has(t.normalized())) snapTasks.push(t);
    }

    // Execution set = everything not marked done, stable file order.
    // Skipped tasks (e.g. a failed account switch from a previous run) are
    // reset to pending so the next run retries them instead of finishing
    // with an empty queue.
    for (const t of snapTasks) {
      if (t.status === 'skipped') t.status = 'pending';
    }
    // Drop snapshot tasks that no longer exist in the current TODO.md —
    // the project may have been switched, and a stale task from another
    // project must not leak into this queue.
    const currentNorms = new Set([...freshDoneNorms, ...freshUncheckedNorms]);
    const queue = snapTasks
      .filter((t) => t.status !== 'done' && currentNorms.has(t.normalized()))
      .sort((a, b) => a.index - b.index);
    st.queue = queue;
    st.switchesUsed = Number(snap['switches_used'] ?? 0);
    st.cooldownUntil = Number(snap['cooldown_until'] ?? 0.0);
    st.eventsWritten = Number(snap['events_written'] ?? 0);
    const cb = snap['cdp_browser'];
    st.cdpBrowser = cb === null || cb === undefined ? null : String(cb);
    st.startedAt = Number(snap['started_at'] ?? st.startedAt);
    return st;
  }
}
