/** CursorHarness TypeScript 重写版 — 统一导出 + CLI 入口。 */

export * from './config';
export * from './cdp';
export * from './cursor';
export * from './fileLock';
export * from './todoQueue';
export * from './runState';
export * from './observer';
export * from './loginAssistant';
export * from './template';
export * from './win32';
// auth / detection 的 `Json` 与 cdp 冲突，ui 的 `init` 与 cursor 冲突 —— 命名空间导出
export * as ui from './ui';
export * as loop from './loop';
export * as cli from './cli';
export * as assistantProbe from './assistantProbe';
export * as auth from './auth';
export * as detection from './detection';

/** loop 直通入口（flag 参数：--check-config / --dry-run / --mode …）。 */
export async function loopMain(argv: string[]): Promise<number> {
  return import('./loop').then((m) => m.main(argv));
}

/** 交互 CLI 入口（子命令：run / plan / status / stats / watch / init / 空 → REPL）。 */
export async function cliMain(argv: string[]): Promise<number> {
  return import('./cli').then((m) => m.main(argv));
}
