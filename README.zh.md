# ♻️ curloop —— 无人值守 Cursor Harness

[English](README.md) | **中文**

[![npm version](https://img.shields.io/npm/v/curloop.svg)](https://www.npmjs.com/package/curloop)
[![npm downloads](https://img.shields.io/npm/dm/curloop.svg)](https://www.npmjs.com/package/curloop)
[![node](https://img.shields.io/node/v/curloop.svg)](https://www.npmjs.com/package/curloop)
[![platform](https://img.shields.io/badge/platform-Windows-0078D4.svg)](https://github.com/daetz-coder/CurLoop)
[![license](https://img.shields.io/npm/l/curloop.svg)](LICENSE)

> **用 TypeScript Harness 驱动真实 Cursor：按目标项目 `TODO.md` 复选框队列无人值守执行，检测用量限制 / 登录失效，经换号助手 GUI 自动换号，重启后续接。** 产品级 Web 控制台把 CLI、日志和 IDE 收进一个浏览器页。

curloop（本仓库 **CursorHarness**）通过 Chrome DevTools Protocol (CDP) 附加到**真实** Cursor 安装。仅 **Windows + Node.js ≥ 22.13**，**零 Python**。默认 `dry-run`；真实换号需 `--mode live`（Web 界面固定 live，启动时自动 UAC 提权）。

> ⚠️ 自动换号绕过用量限制**违反 Cursor ToS**，账号存在风控 / 封禁风险。使用即自行承担。

## ✨ 它能做什么

| 能力 | 说明 |
|------|------|
| 🎯 **TODO 队列** | 解析目标项目 `TODO.md` 复选框，一次发一个任务，完成后勾 `[x]`，并吸收 Agent 追加的新项 |
| 🖥️ **真实 Cursor** | `--remote-debugging-port` 启动 / 附加，向真实输入框打字，轮询真实回复 |
| 🔁 **自动换号** | 撞 limit / 登出时杀 Cursor，点换号助手「刷新 Cursor」+ 确认模板，等 token 翻转后续跑 |
| 🧭 **Web 控制台** | `curloop web` — Tabler + ECharts，全部离线打包（`src/web/vendor/`）。总览 / 控制台 / 轨迹 / 队列 / 事件 / 报告 / 配置 / 提示词 |
| 🧠 **记忆** | 每次结束写 `HARNESS_STATE.md`；可选线程轮转 + 检查点，长跑上下文有界 |
| 🛑 **可控** | `--max-tasks` / `--max-switches`、STOP 文件、Ctrl-C 秒级退出、每次 run 写 `report.json` |

## 🚀 30 秒上手

```bash
# 1. 安装（Windows，Node ≥ 22.13）
npm install -g curloop
# 若本机仍是 0.1.x（Python 壳，无 web 子命令）：
#   npm uninstall -g curloop && npm install -g curloop

# 2. 配置自检（只读）
curloop --check-config

# 3. 打开 Web 控制台（非管理员会弹一次 UAC）
curloop web
```

或在已有 `TODO.md` 的项目根无人值守：

```bash
curloop run --mode live --project D:\path\to\project
curloop run --mode live --max-tasks 10 --max-switches 3
```

两种入口，自动识别：

- **无人值守直通**：第一个参数以 `-` 开头（`--check-config` / `--dry-run` / `--detect-only` / `--mode …`）
- **交互 CLI**：无参数进入 REPL，或子命令 `run` / `plan` / `status` / `stats` / `watch` / `init` / `tasks` / `log` / `stop` / `report` / `web`

REPL 斜杠命令：`/status` `/stats` `/tasks` `/log [N]` `/run` `/plan` `/watch` `/init` `/stop` `/report` `/project <路径>` `/exit`。

## 为什么这样做

- **IDE 就是产品本身**：没有非官方 Cursor API。CDP 向工作区 DOM 注入 JS，向 composer 打字，用**中英文关键词**分类 limit / 登出 / 完成。
- **关弹窗刻意保守**：`DISMISS_JS` 只在**可见** modal 内点安全白名单（`Not now` / `Later` / `取消` / `关闭` / …），**绝不**匹配 Update / Upgrade / Restart / 订阅。工作区加载后几秒才弹出的促销横幅会轮询关到 `modalCount == 0`。
- **Token 不落日志**：`state.vscdb` 用 `node:sqlite` 只读；只打印指纹，从不打印完整 access token。
- **等待是上限不是睡满**：`launch_wait_s` / `confirm_wait_s` / `switch_token_timeout_s` 窗口 / 模板 / token 一就绪就继续。唯一固定睡满的是 `retry.cooldown_between_switches_s`（0.3.1 起默认 **8 秒**）。
- **两个 profile 不混用**：无人值守驱动真实 `%APPDATA%\Cursor`。仓库 `.harness-profile` 只是隔离默认，不是 live profile。

## 目录结构

```
bin/curloop.js                 # Node 入口（flag → loop；子命令 → CLI / web）
src/
  cdp.ts                       # CDP WebSocket（ws）：启动 / 附加 / 注入 / 打字
  auth.ts                      # 只读 state.vscdb + DOM 登录门
  cursor.ts                    # 关弹窗 / 发送 / 轮询 / ensure-ready
  detection.ts                 # limit / 登出 / 完成分类器（注入 JS）
  loginAssistant.ts            # 换号助手 CursorLoginAssistant-836.exe GUI 自动化
  win32.ts + win32.ps1         # PowerShell 桥（Add-Type C#）：窗口 / 截图 / 点击
  template.ts                  # pngjs 灰度 + 降采样 NCC（对齐 CCOEFF_NORMED）
  prompts.ts                   # 8 个可覆盖提示词模板
  loop.ts / cli.ts / web.ts    # 状态机、REPL、HTTP UI
  web/                         # Tabler + ECharts + marked（本地打包，离线可用）
  assets/templates/            # 内置 refresh_cursor.png / confirm_ok.png
unattended/*.bat               # 自提权 + watchdog（必须 ANSI/GBK + CRLF）
config.default.json            # 干净默认；用户覆盖在 %APPDATA%\curloop\config.json
```

`unattended/*.bat` 一律走 `bin/curloop.js` → `dist/`。批处理**必须**保持 ANSI/GBK + CRLF（cmd.exe 用系统 OEM 码页）。

## Web 控制台

```bash
curloop web                     # 默认端口 3080，被占自动 +1（最多 10 次）
curloop web --port 8080
curloop web --no-open           # 只启动服务，不打开浏览器
```

只绑定 `127.0.0.1`。`curloop web` **启动时自动提权**（弹一次 UAC），之后 live / 换号无需再开管理员壳。

浏览器里覆盖全部 CLI：

- **总览**：换号 / 对话 / 完成 / 续接；ECharts 轨迹时间线（任务条 + 换号标记，滚轮缩放）与近 24 小时活动
- **控制**：选项目（浏览 + **保存**为默认）、一键运行（新项目自动初始化 / 扩写 FinalGoal + TODO）、STOP 文件、人在回路「发到 Cursor」
- **初始化圆点**：标题旁绿 / 黄 / 红 / 灰
- **提示词**：可视化编辑 8 个模板；存到 `%APPDATA%\curloop\prompts\<key>.txt`（清空 = 恢复内置）
- **实时日志**：子进程 stdout 流式进终端条；状态 / 事件每 2 秒刷新

## Harness 设计（记忆 / 换号 / 可控 / 收尾）

- **长对话真正有界**
  - `thread.rotate_every_tasks: 6` — 每完成 N 个任务点 New Chat，先固化记忆再发续接提示词（`HARNESS_STATE.md` + git + 剩余 TODO + FinalGoal）。`0` = 保持单线程（默认）
  - `prompt.checkpoint_every_tasks: 5` — 让 Agent 把进度小结写入 `HARNESS_STATE.md`
- **记忆** — 每次结束（`run_done` / 中断 / STOP / 中止 / 崩溃）都写 `HARNESS_STATE.md`。snapshot + `events.jsonl` 仍负责断点续跑
- **提示词** — `PROMPT_DEFS` 注册 8 个模板（任务 / 扩展 / 重规划 / 首次规划 / 检查点 / 最终验收 / 续接 / 初始化扩写）。可选 `prompt.task_prompt_file`（`{project}` `{task}` `{retries}`）。`prompt.goal_in_task: true` 给任务附带 FinalGoal
- **自动换号** — 预算 `retry.max_total_account_switches_per_run`（`0` = 不限）。CLI `--max-switches N` 可覆盖。0.3.1 起缩短 GUI 轮询 / 置顶 sleep，默认冷却 `8`
- **可控**
  - `--max-tasks N` / `control.max_tasks` — 完成 N 个任务后收尾退出 0
  - **STOP 文件**（`<projectDir>/STOP`，或 `control.stop_file`）— 优雅中止，退出码 2（watchdog 不重启）。REPL `/stop` 一键创建
  - Ctrl-C：轮询 sleep 可中断，先存状态再退出 130
- **收尾** — 队列空 + 轻量扩展 + FinalGoal 重规划都无新任务 → 完成。可选 `prompt.final_verify`。每次正常结束写 `runstate/<key>/report.json`

## 配置

默认开箱即用（未配置时自动检测 Cursor / 换号助手常见路径）。本机覆盖：`%APPDATA%\curloop\config.json`（叠在 `config.default.json` 上）。请存 **UTF-8 无 BOM**（记事本 / PowerShell `Out-File` 常写入 BOM，旧版会跳过该文件）。

```jsonc
{
  "project_dir": "D:\\your\\project",            // 也可用 --project；Web 可保存
  "cursor": { "exe": "C:\\Program Files\\cursor\\Cursor.exe" },
  "login_assistant": {
    "exe": "C:\\Users\\you\\Desktop\\CursorLoginAssistant-836.exe",
    "refresh_template": "",                      // 留空 = 用内置打包模板
    "confirm_template": "",
    "launch_wait_s": 20,                         // 上限；窗口一出现就继续
    "confirm_wait_s": 8
  },
  "timeouts": { "switch_token_timeout_s": 45 },  // 等 token 翻转上限
  "retry": { "cooldown_between_switches_s": 8 }  // 换号成功后唯一固定睡满的冷却
}
```

刷新 / 确认模板打在 `dist/assets/templates/`。运行状态在 `%APPDATA%\curloop\runstate`（按项目绝对路径 + git 分支隔离）。

## 目标项目格式

在项目根放 `TODO.md`：

```markdown
- [ ] 任务一
- [x] 已完成
- [ ] 任务二
```

可选 `FinalGoal.md` 描述最终目标。队列清空后先按当前状态轻量扩展，再对照 FinalGoal 重规划；两层都无新任务即判定完成。

## 工作原理

1. 以 `--remote-debugging-port=9333` 启动 / 附加真实 Cursor（真实 `%APPDATA%\Cursor`）
2. 注入 JS 检测 DOM：用量 / 速率限制、登录失效、回复完成（中英文关键词）
3. 促销 / 更新弹窗：只在可见 dialog 内点白名单；`ensureReady` / `sendPrompt` 轮询关到干净；等回复每 3 轮再清一次
4. 撞限 / 掉线：PowerShell 截图 → NCC 模板匹配「刷新 Cursor → 确认」→ 等 token 翻转 → 重启续跑
5. 每个任务完成后 `git commit`；Agent 追加的新复选框下一轮自动入队

## 分发与安装

### 渠道一：npm（推荐）

```bash
npm install -g curloop
curloop web
curloop run --mode live --project D:\path\to\project
```

维护者发布：`npm publish`（无作用域公开包 `curloop`）。

### 渠道二：本仓库开发

```bash
git clone git@github.com:daetz-coder/CurLoop.git
cd CurLoop
npm install
npm run build        # tsc → dist/
npm link             # 全局 curloop 指向本目录
```

`npm run watch` 增量编译。`npm pack` / `npm publish` 会先跑 `prepack` → `npm run build`。

### 渠道三：无人值守启动器

把 `unattended\run_here.bat` 复制到项目根双击（`live` 或 `limit-sim`）。`run_unattended.bat` 自提权一次；watchdog 异常退出最多重启 5 次，`run_done` / 中止 / Ctrl-C 不重启。

## License

[MIT](LICENSE)
