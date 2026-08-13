"""Elevated probe: relaunch the LoginAssistant with --remote-debugging-port and
dump its real DOM (page text + buttons) to runstate/assistant_probe.json.

Run elevated (UAC), e.g. from this session's elevated loop.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets.sync.client as ws_client  # noqa: E402

PORT = 9355
EXE = Path(r"C:\Users\ASUS\Desktop\CursorLoginAssistant-836.exe")
OUT = Path(__file__).resolve().parent / "runstate" / "assistant_probe.json"


def http_json(url: str, timeout: float = 3.0):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def kill_assistant() -> None:
    ps = r"""
Get-CimInstance Win32_Process -Filter "Name = 'CursorLoginAssistant-836.exe'" | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
"""
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, check=False)
    time.sleep(2)


def wait_cdp(timeout_s: float = 40.0):
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        try:
            return http_json(f"http://127.0.0.1:{PORT}/json/version", timeout=2.0)
        except Exception as e:
            last = str(e)
            time.sleep(1.0)
    raise TimeoutError(f"CDP not up on {PORT}: {last}")


DUMP_JS = r"""
(() => {
  const out = { title: document.title, url: location.href, body: (document.body ? document.body.innerText : '').slice(0, 3000), buttons: [] };
  document.querySelectorAll('button, [role="button"], a, [class*="btn" i]').forEach((el, i) => {
    const t = ((el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '') + '').trim();
    if (t && t.length < 60) out.buttons.push({ i, tag: el.tagName, text: t, cls: (el.className||'').toString().slice(0,40) });
  });
  return out;
})()
"""


def main() -> int:
    report = {"ok": False, "launched_pid": None, "cdp": None, "pages": [], "error": None}
    try:
        kill_assistant()
        proc = subprocess.Popen(
            [str(EXE), f"--remote-debugging-port={PORT}", "--remote-allow-origins=*"],
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        report["launched_pid"] = proc.pid
        version = wait_cdp(45.0)
        report["cdp"] = version.get("Browser")
        targets = http_json(f"http://127.0.0.1:{PORT}/json/list")
        for t in targets:
            if t.get("type") != "page":
                continue
            ws = t.get("webSocketDebuggerUrl")
            if not ws:
                continue
            s = ws_client.connect(ws, max_size=16 * 1024 * 1024)
            try:
                s.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
                s.send(json.dumps({"id": 2, "method": "Runtime.evaluate", "params": {"expression": DUMP_JS, "returnByValue": True, "awaitPromise": True}}))
                data = None
                deadline = time.time() + 10
                while time.time() < deadline:
                    msg = json.loads(s.recv())
                    if msg.get("id") == 2:
                        data = msg.get("result", {}).get("result", {}).get("value")
                        break
                report["pages"].append({"title": t.get("title"), "url": (t.get("url") or "")[:120], "dom": data})
            except Exception as e:
                report["error"] = f"page {t.get('title')}: {e}"
            finally:
                s.close()
        report["ok"] = True
    except Exception as e:  # noqa: BLE001
        report["error"] = str(e)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2)[:2000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
