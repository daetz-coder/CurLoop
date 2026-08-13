#!/usr/bin/env python3
"""CursorHarness 实时观察面板（标准库，零依赖）。

读取 unattended/runstate/events.jsonl + snapshot.json，展示：
- 运行状态（mode / 项目 / 已运行时长 / 最近事件）
- 换号统计（次数 / 成功 / 失败 / 账号列表）
- 对话与任务统计（发送次数 / 完成任务 / 自动续接次数）
- 当前 TODO 队列 + 最近事件流

用法：
    python dashboard.py [端口]     # 默认 8765
    # 浏览器打开 http://127.0.0.1:8765 （页面每 3 秒自动刷新）
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from unattended.observer import build_status

HTML = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>CursorHarness 观察面板</title>
<style>
body{font-family:system-ui,'Microsoft YaHei',sans-serif;background:#0f1117;color:#e6e6e6;margin:0;padding:20px}
h1{font-size:18px;margin:0 0 12px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.card{background:#1a1d27;border:1px solid #2a2e3d;border-radius:10px;padding:14px 18px;min-width:130px}
.card .num{font-size:26px;font-weight:700;color:#58c4dd}
.card .lbl{font-size:12px;color:#8a90a3;margin-top:2px}
.ok{color:#4ade80}.warn{color:#fbbf24}.err{color:#f87171}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #23273a}
th{color:#8a90a3;font-weight:600}
td.ev{font-family:ui-monospace,Consolas,monospace;color:#58c4dd}
.statusbar{color:#8a90a3;font-size:12px;margin-bottom:8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.box{background:#1a1d27;border:1px solid #2a2e3d;border-radius:10px;padding:14px}
.box h2{font-size:14px;margin:0 0 8px;color:#aab}
</style></head><body>
<h1>🖥 CursorHarness 观察面板 <span class="statusbar" id="status"></span></h1>
<div class="cards">
  <div class="card"><div class="num" id="c-switch">0</div><div class="lbl">换号次数</div></div>
  <div class="card"><div class="num ok" id="c-switchok">0</div><div class="lbl">换号成功</div></div>
  <div class="card"><div class="num err" id="c-switchfail">0</div><div class="lbl">换号失败</div></div>
  <div class="card"><div class="num" id="c-sends">0</div><div class="lbl">对话发送</div></div>
  <div class="card"><div class="num" id="c-tasks">0</div><div class="lbl">完成任务</div></div>
  <div class="card"><div class="num" id="c-extend">0</div><div class="lbl">自动续接</div></div>
  <div class="card"><div class="num" id="c-mode">-</div><div class="lbl">模式</div></div>
  <div class="card"><div class="num" id="c-running">-</div><div class="lbl">已运行</div></div>
</div>
<div class="grid">
  <div class="box"><h2>当前 TODO 队列</h2><table><thead><tr><th>状态</th><th>任务</th></tr></thead><tbody id="queue"></tbody></table></div>
  <div class="box"><h2>换号账号记录</h2><table><thead><tr><th>#</th><th>账号</th></tr></thead><tbody id="emails"></tbody></table></div>
</div>
<div class="box" style="margin-top:16px"><h2>最近事件</h2>
<table><thead><tr><th style="width:70px">时间</th><th style="width:140px">事件</th><th>详情</th></tr></thead><tbody id="events"></tbody></table>
</div>
<script>
async function refresh(){
  try{
    const r = await fetch('/api/status'); const d = await r.json(); const s = d.stats;
    document.getElementById('c-switch').textContent = s.switches;
    document.getElementById('c-switchok').textContent = s.switch_ok;
    document.getElementById('c-switchfail').textContent = s.switch_failed;
    document.getElementById('c-sends').textContent = s.sends;
    document.getElementById('c-tasks').textContent = s.tasks_done;
    document.getElementById('c-extend').textContent = s.extend_ok;
    document.getElementById('c-mode').textContent = s.mode || '-';
    document.getElementById('c-running').textContent = d.running || '-';
    document.getElementById('status').textContent = '项目: ' + (s.project || '-') + ' | 刷新于 ' + d.now;
    const qb = document.getElementById('queue');
    qb.innerHTML = d.queue.map(t => '<tr><td class="'+t.status+'">'+t.status+'</td><td>'+t.text+'</td></tr>').join('') || '<tr><td colspan=2>队列为空</td></tr>';
    const eb = document.getElementById('emails');
    eb.innerHTML = s.emails.map((e,i)=>'<tr><td>'+(i+1)+'</td><td>'+e+'</td></tr>').join('') || '<tr><td colspan=2>暂无</td></tr>';
    const evb = document.getElementById('events');
    evb.innerHTML = d.recent.map(e => {
      const cls = e.event.includes('fail')||e.event.includes('error') ? 'err' : e.event.includes('switch_ok')||e.event.includes('task_done') ? 'ok' : '';
      return '<tr><td>'+e.t+'</td><td class="ev">'+e.event+'</td><td class="'+cls+'">'+(e.detail||'')+'</td></tr>';
    }).join('');
  }catch(err){ document.getElementById('status').textContent = '连接失败: '+err; }
}
refresh(); setInterval(refresh, 3000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.startswith("/api/status"):
            body = json.dumps(build_status(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            body = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):  # 静默访问日志
        pass


def main() -> int:
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[dashboard] http://127.0.0.1:{port}  (Ctrl-C 停止)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[dashboard] 已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
