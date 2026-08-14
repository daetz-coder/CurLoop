#!/usr/bin/env node
'use strict';
/**
 * cursor-harness —— npm 分发主入口。
 * 等价于：python -m unattended.loop <args>
 * 例：cursor-harness --check-config / --dry-run / --detect-only / --mode live --project <dir>
 */
const { runPython } = require('./_common');

runPython(['-m', 'unattended.loop', ...process.argv.slice(2)], 'cursor-harness');
