import * as fs from 'fs';
import * as path from 'path';
import * as proper from 'proper-lockfile';

/**
 * 跨进程简易文件锁：proper-lockfile 封装（Windows 上可靠、带陈旧锁检测与
 * 自动续期）。语义与 Python 版 msvcrt 字节锁一致：写 snapshot/events/TODO
 * 时独占，避免双 curloop 互踩。锁文件为 `<target>.lock`。
 */

export class FileLock {
  private target: string;
  private releaseFn: (() => Promise<void>) | null = null;

  constructor(lockFilePath: string) {
    // Python 版：锁文件路径即 `.lock`；proper-lockfile 锁定目标文件并生成
    // `<target>.lock`。传入的 lockFilePath 就是“目标文件”，保持外部行为不变
    // （run_state 用 snapshot 旁的 .lock，todo 用 todo.lock）。
    this.target = lockFilePath;
  }

  async acquire(timeoutS = 30.0): Promise<void> {
    try {
      this.releaseFn = await proper.lock(this.target, {
        stale: 10_000,
        update: 2_000,
        retries: {
          retries: Math.max(1, Math.round(timeoutS / 0.1)),
          factor: 1,
          minTimeout: 100,
          maxTimeout: 100,
        },
        realpath: false,
      });
    } catch (e) {
      throw new Error(`file lock timeout: ${path.basename(this.target)} (${String(e)})`);
    }
  }

  async release(): Promise<void> {
    if (this.releaseFn) {
      const fn = this.releaseFn;
      this.releaseFn = null;
      try {
        await fn();
      } catch {
        /* lockfile already gone */
      }
    }
  }
}

/** 便捷上下文：acquire 后执行 fn，finally 释放。 */
export async function withLock<T>(
  lockFilePath: string,
  fn: () => Promise<T>,
  timeoutS = 30.0,
): Promise<T> {
  const lock = new FileLock(lockFilePath);
  await lock.acquire(timeoutS);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ------------------------------------------------------- synchronous lock ----
// Python 版 FileLock 是同步的（msvcrt 字节锁，进程退出自动释放）；Node 的
// proper-lockfile 是异步的，而 runState.log / save / todoQueue.ensureDone 在
// 热路径上必须同步完成。这里用「独占创建锁文件 + mtime 陈旧检测」实现等价
// 语义：锁的就是传入的 lockFilePath 本身（与 Python 一致，不产生 .lock.lock）。

function sleepSync(ms: number): void {
  // Atomics.wait 带超时：真实 OS 等待（不忙转 CPU）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 同步独占锁（进程崩溃后靠 staleMs 陈旧检测兜底）。
 * 与 Python FileLock 语义对齐：锁文件即 lockFilePath；获取失败轮询重试。
 */
export function withSyncLock<T>(
  lockFilePath: string,
  fn: () => T,
  timeoutS = 30.0,
  staleMs = 10_000,
): T {
  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockFilePath, 'wx');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // stale lock：文件 mtime 超过阈值 → 视为崩溃残留，删除重试
        try {
          const st = fs.statSync(lockFilePath);
          if (Date.now() - st.mtimeMs > staleMs) {
            fs.unlinkSync(lockFilePath);
            continue;
          }
        } catch {
          continue; // 被并发删除，重试
        }
        if (Date.now() >= deadline) {
          throw new Error(`file lock timeout: ${path.basename(lockFilePath)}`);
        }
        sleepSync(100);
        continue;
      }
      throw e;
    }
    if (fd !== null) fs.closeSync(fd);
    try {
      return fn();
    } finally {
      try {
        fs.unlinkSync(lockFilePath);
      } catch {
        /* 已被并发删除或已崩溃 */
      }
    }
  }
}
