'use strict';
/**
 * 公共 shim：定位包内嵌入式 Python 并透传运行一个 Python 入口。
 * 保持当前 cwd（curloop 语义：在哪个目录运行，就对哪个目录执行 Harness），
 * 用 PYTHONPATH 指向包根，使 `unattended` 包与根目录脚本可被导入。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PKG_ROOT = path.resolve(__dirname, '..');

function findPython() {
  const candidates = [
    path.join(PKG_ROOT, 'runtime', 'python', 'python.exe'),
    path.join(PKG_ROOT, 'runtime', 'python', 'Scripts', 'python.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function runPython(entryArgs, cmdName) {
  const python = findPython();
  if (!python) {
    console.error(`[${cmdName}] 未找到嵌入式 Python：${path.join('runtime', 'python', 'python.exe')}`);
    console.error('  请重新执行 npm install（postinstall 会自动下载 python-build-standalone）。');
    process.exit(1);
  }
  const child = spawn(python, entryArgs, {
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: PKG_ROOT, PYTHONUTF8: '1' },
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch { /* already gone */ }
    }
    process.exit(code == null ? 0 : code);
  });
}

module.exports = { findPython, runPython, PKG_ROOT };
