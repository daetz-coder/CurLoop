#!/usr/bin/env node
'use strict';
/**
 * curloop —— npm 分发的交互式 CLI 入口。
 * 等价于：python harness.py <args>
 * 例：curloop run / plan / status / stats / watch / init（无参数进入 REPL）
 */
const { runPython } = require('./_common');

runPython(['harness.py', ...process.argv.slice(2)], 'curloop');
