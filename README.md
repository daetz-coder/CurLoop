# curloop

无人值守 Cursor 编码循环（Windows，**TypeScript**）：CDP 驱动**真实 Cursor**，检测用量限制/登录失效后自动换号（换号助手 GUI 自动化）、重启并续接原会话，按目标项目的 `TODO.md` 复选框队列无人值守执行。

> ⚠️ 自动换号绕过用量限制违反 Cursor ToS，账号存在风控/封禁风险。默认 `dry-run`，真实换号需显式 `--mode live` 且以管理员运行。

## 架构（TypeScript 重写版）

纯 Node.js / TypeScript，零 Python 依赖：

- `src/*.ts` — TypeScript 源码（CommonJS 编译到 `dist/`）
  - `cdp.ts` — CDP WebSocket 封装（`ws`）：启动/附加 Cursor、注入 JS、发送/检测
  - `auth.ts` — 只读探测 `state.vscdb` 登录态（`node:sqlite`，绝不打印完整 token）
  - `cursor.ts` — 弹窗关闭 / 发送 prompt / 回复轮询 / ensure-ready
  - `detection.ts` — 用量限制 / 登出 / 回复完成检测（DOM 中英文关键词，注入 JS）
  - `loginAssistant.ts` + `win32.ts` + `win32.ps1` — 换号助手 GUI 自动化：PowerShell 桥（Add-Type C#）窗口/截图/点击
  - `template.ts` — 纯 TS 模板匹配（pngjs 灰度 + 降采样 NCC，语义对齐 pyautogui CCOEFF_NORMED）
  - `prompts.ts` — 提示词 v2：任务执行纪律 + 仓库上下文（git/HARNESS_STATE.md）、长对话检查点、FinalGoal 最终验收
  - `todoQueue.ts` / `runState.ts` / `observer.ts` / `ui.ts` / `fileLock.ts` — TODO 队列、断点续跑（snapshot + events.jsonl）、状态统计、ANSI 渲染、跨进程同步锁
  - `loop.ts` — 无人值守状态机（`--check-config` / `--dry-run` / `--detect-only` / `--mode live|limit-sim`）
  - `cli.ts` — 交互 CLI + REPL（`run` / `plan` / `status` / `stats` / `watch` / `init` / `tasks` / `log` / `stop` / `report`）
  - `web.ts` + `web/index.html` — Web 界面（仿 dsh web）：本地 HTTP 服务器、统计/轨迹可视化、远程运行控制
- `bin/curloop.js` — Node 入口（flag 参数 → loop 直通；子命令/空 → 交互 CLI）

仓库内 `unattended/*.py` 为旧 Python 实现，仅作参考/回归对比，不再维护；入口一律走 `dist/`。

## 安装

要求：**Windows + Node.js ≥ 22.13**（使用 `node:sqlite` 与 `Atomics.wait`）。无需 Python。

```bash
npm install -g curloop        # 或本地开发：npm install && npm run build && npm link
```

## 快速开始

```bash
curloop --check-config            # 配置自检（只读）
curloop status                    # 查看目标项目状态（当前目录 = 目标项目）
curloop run --mode live           # 无人值守运行（需管理员）
curloop run --mode live --project D:\path\to\project
curloop run --mode live --max-tasks 10 --max-switches 3   # 运行预算：最多 10 个任务 / 3 次换号
```

用法分两种，自动识别：

- **无人值守直通**：第一个参数以 `-` 开头（`--check-config` / `--dry-run` / `--detect-only` / `--mode ...` / `--max-tasks N` / `--max-switches N`）
- **交互 CLI**：无参数进入 REPL，或子命令 `run` / `plan` / `status` / `stats` / `watch` / `init` / `tasks` / `log` / `stop` / `report`

REPL 斜杠命令：`/status` `/stats` `/tasks` `/log [N]` `/run` `/plan` `/watch` `/init` `/stop` `/report` `/project <路径>` `/exit`。

## Web 界面（仿 dsh web）

```bash
curloop web                     # 启动 Web UI 并自动打开浏览器（默认端口 3080，被占自动顺延）
curloop web --port 8080         # 指定端口
curloop web --no-open           # 只启动服务，不打开浏览器
```

在浏览器里完成全部 CLI 操作（**CLI 搬到 Web**）：

- **可视化**：统计卡片（换号/对话/完成/续接）、**SVG 轨迹时间线**（任务条：绿=完成、红=跳过、黄=进行中；菱形=换号成功、✗=失败）、TODO 队列、账号列表、最近事件表、结束报告
- **控制**：一键运行（模式/项目/最大任务/最大换号）、停止（写 STOP 文件优雅收尾）、只生成 TODO（plan）、初始化项目（输入最终目标生成 FinalGoal.md + TODO.md）、**手动向 Cursor 发送消息**（人在回路/调试）
- **实时**：运行子进程日志流式回传（刷新页面不中断）；页面每 2 秒自动刷新状态/事件

说明：`live` / `limit-sim` 需要管理员——用管理员终端启动 `curloop web`；服务只绑定 `127.0.0.1`。

## 长对话 / 记忆 / 可控 / 最终（Harness 设计）

- **长对话（真正的压缩）**：
  - `thread.rotate_every_tasks: 6`：每完成 6 个任务自动点「New Chat」开**新线程**，先固化记忆再发**续接提示词**
    （HARNESS_STATE.md + git + 剩余 TODO + FinalGoal），上下文有界、长跑不降质；0 = 保持单线程（默认）
  - `prompt.checkpoint_every_tasks: 5`：让 Agent 定期把进度小结写入 `HARNESS_STATE.md`
- **记忆（持久化）**：`HARNESS_STATE.md` 由 harness 在**每次结束**（run_done / 中断 / STOP / 中止 / 崩溃）自动生成
  （队列 + 账号 + 最近事件），任何新会话/恢复都有最低上下文；snapshot.json + events.jsonl 断点续跑不变
- **提示词（可定制）**：`prompt.task_prompt_file` 指定自定义任务提示词文件（支持 `{project}` `{task}` `{retries}`
  占位符，存在则完全覆盖内置）；`prompt.goal_in_task: true` 让任务提示词附带 FinalGoal 目标提示
- **自动换号**：撞 limit/登出自动换号（`login_assistant`），预算 `retry.max_total_account_switches_per_run`（0=不限）；
  CLI `--max-switches N` 可临时覆盖。
- **可控**：
  - `--max-tasks N` / `control.max_tasks`：单次 run 完成任务上限（到点收尾退出 0）
  - **STOP 文件**（`<projectDir>/STOP`，或 `control.stop_file` 自定义）：运行中检测到即优雅中止，
    退出码 2（watchdog 不重启）；REPL 里 `/stop` 一键创建，删除文件可取消
  - Ctrl-C 秒级响应：所有轮询 sleep 可中断，先保存状态再退出（130）
- **最终（收尾）**：
  - 队列空 + 轻量扩展 + FinalGoal 重规划都无新任务 → 判定目标完成退出
  - 可选 `prompt.final_verify: true`：三层收尾——让 Agent 对照 FinalGoal 做最后一次验收
  - 每次正常结束（run_done / max_tasks / stop / abort）写入 `runstate/<key>/report.json` 结束报告；
    REPL `/report` 查看，控制台也会打印一行摘要

## 配置

默认配置开箱即用（Cursor / 换号助手路径未配置时会自动检测常见安装位置）。本机配置写在 `%APPDATA%\curloop\config.json`，自动合并并覆盖默认值：

```jsonc
{
  "project_dir": "D:\\your\\project",            // 目标项目（也可用 --project 指定）
  "cursor": { "exe": "C:\\Program Files\\cursor\\Cursor.exe" },
  "login_assistant": {
    "exe": "C:\\Users\\you\\Desktop\\CursorLoginAssistant-836.exe",
    "refresh_template": "C:\\Users\\you\\Desktop\\refresh_cursor.png",
    "confirm_template": "C:\\Users\\you\\Desktop\\confirm_ok.png"
  }
}
```

运行状态（队列快照 / 事件日志）默认存 `%APPDATA%\curloop\runstate`。

## 目标项目格式

在目标项目根目录放 `TODO.md`（复选框任务队列）：

```markdown
- [ ] 任务一
- [x] 已完成
- [ ] 任务二
```

可选 `FinalGoal.md` 描述最终目标；队列清空后会自动基于当前状态轻量扩展，扩展不到新任务时再对照 FinalGoal 重规划，两层都无新任务即判定目标完成。

## 工作原理

1. 以 `--remote-debugging-port=9333` 启动/附加真实 Cursor（真实 `%APPDATA%\Cursor` 配置）
2. 通过 CDP 注入 JS 检测 DOM：用量/速率限制、登录失效、回复完成状态（中英文关键词）
3. 撞限/掉线时自动换号：PowerShell 桥截图 → 纯 TS 模板匹配「刷新Cursor → 确认」→ 等 token 翻转 → 重启续跑
4. 每个任务完成后自动 `git commit`，队列动态吸收 Agent 追加的新任务

## 从源码开发

```bash
git clone git@github.com:daetz-coder/CurLoop.git
cd CurLoop
npm install
npm run build        # tsc → dist/
npm link             # 本地 curloop 命令指向本目录
```

`npm run watch` 可增量编译。`npm pack` 前会自动 `npm run build`（prepack）。

## License

UNLICENSED（私有项目，未经授权禁止分发）。
