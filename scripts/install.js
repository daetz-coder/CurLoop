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
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const PY_DIR = path.join(RUNTIME, 'python');
const PY_EXE = path.join(PY_DIR, 'python.exe');

// 进度日志：npm 11 的 allow-scripts 会缓冲 postinstall 的 stdout（成功时只显示转圈），
// 所以把每个阶段的进度同时写入 %APPDATA%\curloop\install.log，开第二个终端
// `Get-Content -Wait $env:APPDATA\curloop\install.log` 即可实时查看。
const LOG_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'curloop', 'install.log'
);

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch { /* 日志写入失败不影响安装 */ }
}

function log(...a) {
  const line = `[curloop install] ${a.join(' ')}`;
  console.log(line);
  appendLog(line);
}
function err(...a) {
  const line = `[curloop install] ${a.join(' ')}`;
  console.error(line);
  appendLog(line);
}

// python-build-standalone 锁定版本（可复现；stripped 去掉调试符号更小）
const PY_VER = '3.12.13';
const TAG = '20260807';
const ASSET =
  `cpython-${PY_VER}%2B${TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;
const GH_PATH =
  `astral-sh/python-build-standalone/releases/download/${TAG}/${ASSET}`;
const DEFAULT_URL = `https://github.com/${GH_PATH}`;
// 镜像（2026-08 实测：ghproxy.net / gh.ddlc.top 快；ghfast.top / mirror.ghproxy.com 慢但可用。
// gitmirror.com 域名已失效（ENOTFOUND），勿再加回。各镜像 URL 格式不同：
// 有的要 github.com 前缀，有的要完整 https:// 前缀，改前务必实测 HTTP 200 + 正确 content-length。）
const MIRROR_URLS = [
  `https://ghproxy.net/github.com/${GH_PATH}`,
  `https://gh.ddlc.top/github.com/${GH_PATH}`,
  `https://ghfast.top/https://github.com/${GH_PATH}`,
  `https://mirror.ghproxy.com/https://github.com/${GH_PATH}`,
];

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

async function pipInstall() {
  const req = path.join(ROOT, 'requirements.txt');
  // 显式指定 index-url：避免被用户 %APPDATA%\pip\pip.ini（如指向不稳定镜像）劫持。
  // 优先尊重用户显式设置的 PIP_INDEX_URL；否则 PyPI 官方，整体重试后自动切腾讯云镜像。
  const envIndex = (process.env.PIP_INDEX_URL || '').trim();
  const indexes = [
    envIndex || 'https://pypi.org/simple/',
    'https://mirrors.cloud.tencent.com/pypi/simple/',
  ];
  log('安装 Python 依赖 (pip install -r requirements.txt) ...');
  // 国内直连 PyPI 偶发断流（IncompleteRead/ECONNRESET），pip 内建 retries + 外层整体重试 + 换源
  const attempts = 3;
  let r = null;
  for (let i = 1; i <= attempts; i++) {
    const index = indexes[Math.min(i - 1, indexes.length - 1)];
    if (i > 1) log(`pip 网络中断，第 ${i}/${attempts} 次重试 (index: ${index}) ...`);
    r = spawnSync(
      PY_EXE,
      ['-m', 'pip', 'install', '--disable-pip-version-check',
       '--retries', '3', '--timeout', '60',
       '--index-url', index, '-r', req],
      { stdio: 'inherit' }
    );
    if (r.status === 0) break;
    err(`pip install 失败 (exit ${r.status})，第 ${i}/${attempts} 次`);
    if (i < attempts) await sleep(1500 * i);
  }
  if (r.status !== 0) {
    err('pip install 重试后仍失败 (exit', r.status, ')');
    err('可手动指定可用镜像后重装：');
    err('  $env:PIP_INDEX_URL = "https://mirrors.cloud.tencent.com/pypi/simple/"');
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
  try { fs.writeFileSync(LOG_FILE, ''); } catch { /* ignore */ }
  log(`安装开始。进度日志: ${LOG_FILE}`);
  log('（npm 11 缓冲了终端输出，可另开终端实时查看上面日志文件）');
  await ensurePython();
  await pipInstall();
  log('完成。命令：curloop --check-config / curloop run');
})().catch((e) => { err(e); process.exit(1); });
