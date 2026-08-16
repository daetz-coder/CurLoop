// curloop web 控制台实时监控：轮询 /api/console 增量日志 + /api/status
// 自动识别异常行（error/fail/abort/失败/异常/超时/拒绝等）并高亮
const http = require('http');
const PORT = 3099;

function get(url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: url }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

// 异常/警告关键词（英文 + 中文）——避免命中"失败 0"这类计数行
const ERR_RE = /(?:error|fail(?:ed|ure)?|abort|exception|timeout|refused|denied|crash|killed|panic|errno|econn|etimedout|esock|EADDRINUSE)\b|(?:错误|失败|异常|超时|中止|拒绝|崩溃|无法|不能|不可用|未就绪|退出码 [1-9])/i;
const WARN_RE = /(?:warn|retry(?:ing)?|slow|cooldown)\b|(?:警告|重试|缓慢)/i;
// 明确排除：计数行（"失败 0"）与历史 run_abort 收尾记录
const OK_LINE_RE = /成功 \d+.*失败 \d+|失败 \d+.*成功 \d+/i;

let since = 0;
let lastRunning = null;
let consecutive = 0;

async function tick() {
  try {
    const c = await get('/api/console?since=' + since);
    if (c && c.ok && Array.isArray(c.lines) && c.lines.length) {
      for (const line of c.lines) {
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        if (OK_LINE_RE.test(line)) {
          console.log(`\x1b[36m[${ts}] ${line}\x1b[0m`); // 计数行：普通显示
        } else if (ERR_RE.test(line)) {
          console.log(`\x1b[31m[${ts}] ⚠ ${line}\x1b[0m`); // 红 = 异常
        } else if (WARN_RE.test(line)) {
          console.log(`\x1b[33m[${ts}] ▲ ${line}\x1b[0m`); // 黄 = 警告
        } else {
          console.log(`\x1b[36m[${ts}] ${line}\x1b[0m`); // 青 = 普通
        }
      }
      since = c.since;
    }
    // 运行状态变化检测
    const st = await get('/api/status');
    if (st && st.ok) {
      const running = Boolean(st.running);
      if (lastRunning !== null && running !== lastRunning) {
        console.log(`\x1b[35m[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ▶ 运行状态: ${lastRunning ? '结束' : '开始'} (exitCode=${st.exitCode})\x1b[0m`);
      }
      lastRunning = running;
    }
    consecutive = 0;
  } catch (e) {
    consecutive++;
    if (consecutive === 1 || consecutive % 10 === 0) {
      console.log(`\x1b[31m[监控] 连接服务器失败: ${e.message}（连续 ${consecutive} 次）\x1b[0m`);
    }
  }
}

console.log('\x1b[1m=== curloop web 控制台实时监控 ===\x1b[0m');
console.log('监听: http://127.0.0.1:' + PORT + ' （异常=红 / 警告=黄 / 普通=青 / 状态切换=紫）\n');
tick();
setInterval(tick, 1500);
process.on('SIGINT', () => { console.log('\n[监控] 已停止'); process.exit(0); });
