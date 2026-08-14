'use strict';
/**
 * cursor-harness postinstall：
 *   1) 下载嵌入式 Python（python-build-standalone install_only，Windows x86_64）
 *      到 <pkg>/runtime/python/（已存在则跳过下载）
 *   2) pip install -r requirements.txt
 *
 * 下载源默认 GitHub releases；国内/内网可设环境变量 CURSOR_HARNESS_PYTHON_URL
 * 指向镜像（tar.gz，python-build-standalone install_only 包）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const PY_DIR = path.join(RUNTIME, 'python');
const PY_EXE = path.join(PY_DIR, 'python.exe');

// python-build-standalone 锁定版本（可复现；stripped 去掉调试符号更小）
const PY_VER = '3.12.13';
const TAG = '20260807';
const DEFAULT_URL =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}/` +
  `cpython-${PY_VER}%2B${TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;

function log(...a) { console.log('[cursor-harness install]', ...a); }
function err(...a) { console.error('[cursor-harness install]', ...a); }

/** https GET 下载（手动跟随 302/301 重定向，Node 原生模块不自动跟）。 */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code} (${url})`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function ensurePython() {
  if (fs.existsSync(PY_EXE)) {
    log('嵌入式 Python 已存在，跳过下载:', PY_EXE);
    return;
  }
  const url = process.env.CURSOR_HARNESS_PYTHON_URL || DEFAULT_URL;
  fs.mkdirSync(PY_DIR, { recursive: true });
  const tarball = path.join(RUNTIME, '_python.tar.gz');
  log(`下载嵌入式 Python ${PY_VER} (${Math.round(21)}MB) ...`);
  try {
    await download(url, tarball);
  } catch (e) {
    err('下载失败:', e.message);
    err('可设置环境变量 CURSOR_HARNESS_PYTHON_URL 指向镜像（install_only tar.gz）后重新 npm install。');
    process.exit(1);
  }
  log('解压中...');
  await tar.x({ file: tarball, cwd: PY_DIR });
  // install_only 包顶层是 python/ 子目录 → 内容上移一层，使 python.exe 位于 PY_DIR 根
  const inner = path.join(PY_DIR, 'python');
  if (fs.existsSync(inner)) {
    for (const entry of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, entry), path.join(PY_DIR, entry));
    }
    fs.rmdirSync(inner);
  }
  fs.unlinkSync(tarball);
  log('Python 就绪:', PY_EXE);
}

function pipInstall() {
  const req = path.join(ROOT, 'requirements.txt');
  log('安装 Python 依赖 (pip install -r requirements.txt) ...');
  const r = spawnSync(
    PY_EXE,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', req],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) {
    err('pip install 失败 (exit', r.status, ')');
    process.exit(r.status || 1);
  }
}

(async () => {
  await ensurePython();
  pipInstall();
  log('完成。命令：cursor-harness --dry-run / curloop --help');
})().catch((e) => { err(e); process.exit(1); });
