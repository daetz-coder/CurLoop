#!/usr/bin/env node
'use strict';
/**
 * curloop —— 全局命令入口（合并两种用法）：
 *   - 第一个参数以 `-` 开头（--check-config / --dry-run / --detect-only / --mode live --project X ...）
 *     → 无人值守直通：等价 `python -m unattended.loop`
 *   - 其他（run / plan / status / stats / watch / init / 空）→ 交互 CLI：等价 `python harness.py`
 */
const path = require('path');
const { runPython, PKG_ROOT } = require('./_common');

const first = process.argv[2];
if (first && first.startsWith('-')) {
  runPython(['-m', 'unattended.loop', ...process.argv.slice(2)], 'curloop');
} else {
  // harness.py 必须用绝对路径：python 的 cwd 是用户当前目录（curloop 语义），
  // 相对路径会在目标项目目录里找 harness.py 而失败。
  runPython([path.join(PKG_ROOT, 'harness.py'), ...process.argv.slice(2)], 'curloop');
}
