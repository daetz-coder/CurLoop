import * as fs from 'fs';
import * as path from 'path';
import { USER_CONFIG_DIR, projectStateKey } from './config';
import { EVENT_LOG_KEEP, eventLogPaths } from './runState';
import { norm, parseAll } from './todoQueue';

/** 共享观察逻辑：读 runstate/events.jsonl + snapshot.json，计算运行状态与统计。
 *
 * 被 cli（status/stats/watch）与 loop 周期状态块复用，保证统计口径一致。
 * runstate 根目录与 Config.stateDir 同源（默认 %APPDATA%\curloop\runstate）。
 */

interface CacheEntry {
  mtimeKey: string;
  events: Record<string, unknown>[];
  path: string;
}
let cache: CacheEntry = { mtimeKey: '', events: [], path: '' };

/** 与 config.projectStateDir / projectStateKey 同源。 */
function stateKey(project: string): string {
  return projectStateKey(path.resolve(project));
}

/** 默认与 Config.stateDir 一致：%APPDATA%\curloop\runstate。 */
export function runstateRoot(stateDir?: string): string {
  return stateDir ?? path.join(USER_CONFIG_DIR, 'runstate');
}

/** events.jsonl for a (project, branch, path) pair; undefined = most recently active. */
export function eventsPath(project?: string | null, stateDir?: string): string {
  const root = runstateRoot(stateDir);
  if (project) return path.join(root, stateKey(project), 'events.jsonl');
  let best = path.join(root, 'events.jsonl'); // 回退旧全局
  let bestMt = 0.0;
  try {
    for (const p of fs.readdirSync(root)) {
      const full = path.join(root, p, 'events.jsonl');
      try {
        const mt = fs.statSync(full).mtimeMs;
        if (mt > bestMt) {
          best = full;
          bestMt = mt;
        }
      } catch {
        /* not a runstate dir */
      }
    }
  } catch {
    /* no runstate dir yet */
  }
  return best;
}

export function snapshotPath(project?: string | null, stateDir?: string): string {
  return path.join(path.dirname(eventsPath(project, stateDir)), 'snapshot.json');
}

function mtimeKey(paths: string[]): string {
  const parts: string[] = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      parts.push(`${p}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${p}:missing`);
    }
  }
  return parts.join('|');
}

/** Read events.jsonl + 轮转段 (.1…N)，按时间从旧到新合并；按各文件 mtime 缓存。 */
export function loadEvents(project?: string | null, stateDir?: string): Record<string, unknown>[] {
  const p = eventsPath(project, stateDir);
  const paths = eventLogPaths(p, EVENT_LOG_KEEP);
  if (!paths.length) {
    // 事件文件已不存在（第一次运行 / 已被清理）：不能返回旧缓存——
    // 否则清理 runstate 或切换项目后，旧账号/旧事件会一直显示。
    cache = { mtimeKey: '', events: [], path: p };
    return [];
  }
  try {
    const key = mtimeKey(paths);
    if (key !== cache.mtimeKey || p !== cache.path) {
      const evs: Record<string, unknown>[] = [];
      for (const fp of paths) {
        try {
          for (const line of fs.readFileSync(fp, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
              evs.push(JSON.parse(line) as Record<string, unknown>);
            } catch {
              /* skip bad line */
            }
          }
        } catch {
          /* file gone */
        }
      }
      cache = { mtimeKey: key, events: evs, path: p };
    }
    return cache.events;
  } catch {
    return cache.events;
  }
}

export function loadSnapshot(project?: string | null, stateDir?: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(project, stateDir), 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function fmtTs(ts: unknown): string {
  try {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '?';
    const d = new Date(n * 1000);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return '?';
  }
}

export function shortDetail(e: Record<string, unknown>): string {
  for (const k of ['detail', 'reason', 'task']) {
    const v = e[k];
    if (v) return String(v).slice(0, 80);
  }
  return '';
}

/** 状态展示的完整 TODO 列表：直接解析 TODO.md（含已完成 + 待办），
 *  并用 snapshot 的 running 状态标记当前正在执行的任务。 */
function todoAlignedQueue(
  project: string | null | undefined,
  snap: Record<string, unknown>,
  stateDir?: string,
): Array<{ text: string; status: string | undefined; retries: number; switch_reason: unknown }> {
  // 找到最近一次 run 使用的 TODO 文件
  let todo: string | null = null;
  for (const e of loadEvents(project, stateDir)) {
    if (e['event'] === 'run_start' && e['todo']) todo = String(e['todo']); // 保留最后一次
  }
  const todoFile = todo && fs.existsSync(todo) ? todo : (project ? path.join(project, 'TODO.md') : null);

  // 完整列表来自 TODO.md（含 [x] 已完成），顺序 = 文件顺序
  const tasks = todoFile && fs.existsSync(todoFile) ? parseAll(todoFile) : [];
  if (!tasks.length) {
    // 无 TODO.md：回退 snapshot 队列（至少展示运行中的状态）
    const raw = (snap['queue'] as Record<string, unknown>[]) || [];
    return raw.map((t) => ({
      text: String(t['text'] ?? '').slice(0, 70),
      status: t['status'] as string | undefined,
      retries: Number(t['retries'] ?? 0),
      switch_reason: t['switch_reason'],
    }));
  }

  // snapshot 中 running 的任务 → 标记为进行中（按规范化文本匹配）
  const runningNorms = new Set(
    ((snap['queue'] as Record<string, unknown>[]) || [])
      .filter((t) => t['status'] === 'running' || t['status'] === 'pending')
      .map((t) => norm(String(t['text'] ?? ''))),
  );

  return tasks.map((t) => {
    const isRunning = runningNorms.has(t.normalized());
    const status = t.done ? 'done' : isRunning ? 'running' : 'pending';
    return { text: t.text, status, retries: t.retries, switch_reason: null };
  });
}

export interface StatusStats {
  switches: number;
  switch_ok: number;
  switch_failed: number;
  emails: string[];
  sends: number;
  tasks_done: number;
  tasks_start: number;
  extend_ok: number;
  run_start: number | null;
  run_end: number | null;
  run_end_kind: string | null;
  mode: string | null;
  project: string | null;
}

export interface StatusReport {
  stats: StatusStats;
  recent: Array<{ t: string; event: unknown; detail: string }>;
  queue: Array<{ text: string; status: string | undefined; retries: number; switch_reason: unknown }>;
  running: string;
  now: string;
}

function freshStats(): StatusStats {
  return {
    switches: 0,
    switch_ok: 0,
    switch_failed: 0,
    emails: [],
    sends: 0,
    tasks_done: 0,
    tasks_start: 0,
    extend_ok: 0,
    run_start: null,
    run_end: null,
    run_end_kind: null,
    mode: null,
    project: null,
  };
}

/** Compute stats + recent events + queue from the runstate files. */
export function buildStatus(project?: string | null, stateDir?: string): StatusReport {
  const evs = loadEvents(project, stateDir);
  const snap = loadSnapshot(project, stateDir);
  let st: StatusStats = freshStats();
  for (const e of evs) {
    const ev = e['event'];
    if (ev === 'run_start') {
      // 每次 run 独立统计：新一轮 run 开始重置所有计数，不跨 run 累计
      st = freshStats();
      st.run_start = Number(e['ts'] ?? 0) || null;
      st.mode = e['mode'] === undefined ? null : String(e['mode']);
      st.project = e['project'] === undefined ? null : String(e['project']);
    } else if (ev === 'interrupt' || ev === 'run_done' || ev === 'run_abort') {
      st.run_end = Number(e['ts'] ?? 0) || null;
      st.run_end_kind = String(ev);
    } else if (ev === 'switch_start') {
      st.switches += 1;
    } else if (ev === 'switch_ok') {
      st.switch_ok += 1;
      if (e['email']) st.emails.push(String(e['email']));
    } else if (ev === 'switch_failed') {
      st.switch_failed += 1;
    } else if (ev === 'sent') {
      st.sends += 1;
    } else if (ev === 'task_done') {
      st.tasks_done += 1;
    } else if (ev === 'task_start') {
      st.tasks_start += 1;
    } else if (ev === 'extend_result' && Number(e['new_tasks'] ?? 0) > 0) {
      st.extend_ok += 1;
    }
  }

  let running = '-';
  if (st.run_start) {
    if (st.run_end) {
      const kinds: Record<string, string> = { interrupt: '中断', run_done: '完成', run_abort: '中止' };
      running = `已停止(${kinds[st.run_end_kind ?? ''] ?? st.run_end_kind ?? ''})`;
    } else {
      running = `${Math.floor(Date.now() / 1000 - st.run_start)}s`;
    }
  }

  const recent = evs
    .slice(-30)
    .reverse()
    .map((e) => ({ t: fmtTs(e['ts']), event: e['event'], detail: shortDetail(e) }));
  const queue = todoAlignedQueue(project, snap, stateDir);
  return {
    stats: st,
    recent,
    queue,
    running,
    now: fmtTs(Date.now() / 1000),
  };
}
