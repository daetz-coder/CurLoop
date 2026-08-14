#!/usr/bin/env node
'use strict';
/**
 * curloop —— 全局命令入口（合并两种用法）：
 *   - 第一个参数以 `-` 开头（--check-config / --dry-run / --detect-only / --mode live --project X ...）
 *     → 无人值守直通：等价 `python -m unattended.loop`
 *   - 其他（run / plan / status / stats / watch / init / 空）→ 交互 CLI：等价 `python harness.py`
 */
const { runPython } = require('./_common');

const first = process.argv[2];
if (first && first.startsWith('-')) {
  runPython(['-m', 'unattended.loop', ...process.argv.slice(2)], 'curloop');
} else {
  runPython(['harness.py', ...process.argv.slice(2)], 'curloop');
}
