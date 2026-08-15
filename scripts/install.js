'use strict';
/**
 * curloop postinstall：
 *   1) 下载嵌入式 Python（python-build-standalone install_only，Windows x86_64）
 *      到 <pkg>/runtime/python/（已存在则跳过下载）
 *   2) pip install -r requirements.txt
 *
 * 下载源：默认 GitHub；失败时自动试若干镜像。也可设 CURSOR_HARNESS_PYTHON_URL
 * 指向自定义镜像（tar.gz，python-build-standalone install_only 包）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const PY_DIR = path.join(RUNTIME, 'python');
const PY_EXE = path.join(PY_DIR, 'python.exe');

// python-build-standalone 锁定版本（可复现；stripped 去掉调试符号更小）
const PY_VER = '3.12.13';
const TAG = '20260807';
const ASSET =
  `cpython-${PY_VER}%2B${TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;
const GH_PATH =
  `astral-sh/python-build-standalone/releases/download/${TAG}/${ASSET}`;
const DEFAULT_URL = `https://github.com/${GH_PATH}`;
const MIRROR_URLS = [
  `https://ghfast.top/https://github.com/${GH_PATH}`,
  `https://gitmirror.com/https://github.com/${GH_PATH}`,
  `https://mirror.ghproxy.com/https://github.com/${GH_PATH}`,
];

function log(...a) { console.log('[curloop install]', ...a); }
function err(...a) { console.error('[curloop install]', ...a); }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** https/http GET 下载（手动跟随重定向；带超时）。 */
function download(url, dest, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return download(next, dest, timeoutMs).then(resolve, reject);
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
    req.on('timeout', () => {
      req.destroy(new Error(`timeout ${timeoutMs}ms (${url})`));
    });
    req.on('error', reject);
  });
}

function candidateUrls() {
  const envUrl = (process.env.CURSOR_HARNESS_PYTHON_URL || '').trim();
  const list = [];
  if (envUrl) list.push(envUrl);
  list.push(DEFAULT_URL, ...MIRROR_URLS);
  return [...new Set(list)];
}

async function downloadWithFallback(dest) {
  const urls = candidateUrls();
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        log(`下载嵌入式 Python ${PY_VER} (~21MB) [${i + 1}/${urls.length} try${attempt}] ...`);
        log(`  ${url}`);
        await download(url, dest);
        return url;
      } catch (e) {
        lastErr = e;
        err(`  失败: ${e.message}`);
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        await sleep(800 * attempt);
      }
    }
  }
  throw lastErr || new Error('all download sources failed');
}

async function ensurePython() {
  if (fs.existsSync(PY_EXE)) {
    log('嵌入式 Python 已存在，跳过下载:', PY_EXE);
    return;
  }
  fs.mkdirSync(PY_DIR, { recursive: true });
  const tarball = path.join(RUNTIME, '_python.tar.gz');
  try {
    await downloadWithFallback(tarball);
  } catch (e) {
    err('下载失败:', e.message);
    err('国内网络常无法直连 GitHub。可选：');
    err('  1) 设置镜像后再装：');
    err('       $env:CURSOR_HARNESS_PYTHON_URL = "<镜像 tar.gz URL>"');
    err('       npm install -g curloop --registry https://registry.npmjs.org');
    err('  2) 跳过下载，手动放入 runtime：');
    err('       npm install -g curloop --registry https://registry.npmjs.org --ignore-scripts');
    err('       将 python-build-standalone 解压到：');
    err(`       ${PY_EXE}`);
    err('       然后：');
    err(`       & "${PY_EXE}" -m pip install -r requirements.txt`);
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
  // 健康检查：关键依赖可导入才认为安装成功，避免"装了但缺依赖"的静默失败。
  const check = spawnSync(
    PY_EXE,
    ['-c', 'import websockets, pyautogui, pyscreeze, PIL, cv2, prompt_toolkit; print("deps ok")'],
    { stdio: 'pipe', encoding: 'utf-8' }
  );
  if (check.status !== 0) {
    err('依赖健康检查失败（import 错误如下），请重试 npm install：');
    process.stderr.write(check.stderr || '');
    process.exit(check.status || 1);
  }
  log('依赖健康检查通过:', (check.stdout || '').trim());
}

(async () => {
  await ensurePython();
  pipInstall();
  log('完成。命令：curloop --check-config / curloop run');
})().catch((e) => { err(e); process.exit(1); });
