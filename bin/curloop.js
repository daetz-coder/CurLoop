#!/usr/bin/env node
'use strict';
/**
 * curloop —— 全局命令入口（TypeScript 重写版，纯 Node，无 Python）：
 *   - 第一个参数以 `-` 开头（--check-config / --dry-run / --detect-only / --mode live --project X ...）
 *     → 无人值守直通：dist/loop.js main()
 *   - 其他（run / plan / status / stats / watch / init / 空）→ 交互 CLI：dist/cli.js main()
 */
const path = require('path');

function load() {
  const distIndex = path.join(__dirname, '..', 'dist', 'index.js');
  try {
    return require(distIndex);
  } catch (e) {
    console.error('[curloop] 未找到编译产物 ' + distIndex);
    console.error('[curloop] 请先运行: npm run build （开发目录）或在安装时确认 dist/ 已打包');
    console.error('[curloop] 原始错误:', e && e.message);
    process.exit(1);
  }
}

(async () => {
  const api = load();
  const first = process.argv[2];
  let rc;
  if (first && first.startsWith('-')) {
    rc = await api.loopMain(process.argv.slice(2));
  } else {
    rc = await api.cliMain(process.argv.slice(2));
  }
  process.exitCode = typeof rc === 'number' ? rc : 0;
})().catch((e) => {
  console.error('[curloop] 未捕获异常:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
