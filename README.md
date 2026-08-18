# curloop

无人值守 Cursor 编码循环（Windows，**TypeScript**）：CDP 驱动**真实 Cursor**，检测用量限制/登录失效后自动换号（换号助手 GUI 自动化）、重启并续接原会话，按目标项目的 `TODO.md` 复选框队列无人值守执行。

> ⚠️ 自动换号绕过用量限制违反 Cursor ToS，账号存在风控/封禁风险。默认 `dry-run`，真实换号需 `--mode live`（Web 界面固定 live 并自动提权）。

## 架构（TypeScript 重写版）

纯 Node.js / TypeScript，零 Python 依赖：

- `src/*.ts` — TypeScript 源码（CommonJS 编译到 `dist/`）
  - `cdp.ts` — CDP WebSocket 封装（`ws`）：启动/附加 Cursor、注入 JS、发送/检测
  - `auth.ts` — 只读探测 `state.vscdb` 登录态（`node:sqlite`，绝不打印完整 token）
  - `cursor.ts` — 弹窗关闭 / 发送 prompt / 回复轮询 / ensure-ready
  - `detection.ts` — 用量限制 / 登出 / 回复完成检测（DOM 中英文关键词，注入 JS）
  - `loginAssistant.ts` + `win32.ts` + `win32.ps1` — 换号助手 GUI 自动化：PowerShell 桥（Add-Type C#）窗口/截图/点击
  - `template.ts` — 纯 TS 模板匹配（pngjs 灰度 + 降采样 NCC，语义对齐 pyautogui CCOEFF_NORMED）
  - `prompts.ts` — 提示词注册表（8 个可编辑模板）+ 任务执行纪律 + 仓库上下文（git/HARNESS_STATE.md）、长对话检查点、FinalGoal 最终验收；支持 `%APPDATA%\curloop\prompts\<key>.txt` 覆盖
  - `todoQueue.ts` / `runState.ts` / `observer.ts` / `ui.ts` / `fileLock.ts` — TODO 队列、断点续跑（snapshot + events.jsonl）、状态统计、ANSI 渲染、跨进程同步锁
  - `loop.ts` — 无人值守状态机（`--check-config` / `--dry-run` / `--detect-only` / `--mode live|limit-sim`）
  - `cli.ts` — 交互 CLI + REPL（`run` / `plan` / `status` / `stats` / `watch` / `init` / `tasks` / `log` / `stop` / `report` / `web`）
  - `web.ts` + `web/index.html` — Web 界面（仿 dsh web）：本地 HTTP 服务器、统计/轨迹可视化、远程运行控制
- `bin/curloop.js` — Node 入口（flag 参数 → loop 直通；子命令/空 → 交互 CLI）

`unattended/*.bat` 为本地开发启动器（自提权 + watchdog），入口一律走 `bin/curloop.js` → `dist/`。

## 安装

要求：**Windows + Node.js ≥ 22.13**（使用 `node:sqlite` 与 `Atomics.wait`）。无需 Python。

```bash
npm install -g curloop        # 当前 latest：0.3.1
# 若本机仍是 0.1.x（Python 壳，无 web 子命令）：npm uninstall -g curloop && npm install -g curloop
# 本地开发：npm install && npm run build && npm link
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
- **交互 CLI**：无参数进入 REPL，或子命令 `run` / `plan` / `status` / `stats` / `watch` / `init` / `tasks` / `log` / `stop` / `report` / `web`

REPL 斜杠命令：`/status` `/stats` `/tasks` `/log [N]` `/run` `/plan` `/watch` `/init` `/stop` `/report` `/project <路径>` `/exit`。

## Web 界面（仿 dsh web）

```bash
curloop web                     # 启动 Web UI 并自动打开浏览器（默认端口 3080，被占自动顺延）
curloop web --port 8080         # 指定端口
curloop web --no-open           # 只启动服务，不打开浏览器
```

在浏览器里完成全部 CLI 操作（**CLI 搬到 Web**）：

- **产品级 UI**：Tabler 组件库 + ECharts 图表，全部**本地打包**（`src/web/vendor/`，离线可用）
- **可视化**：统计卡片（换号/对话/完成/续接）、**ECharts 轨迹时间线**（任务条+换号标记，滚轮缩放/拖拽）、
  近 24 小时活动柱状图、TODO 队列、账号列表、事件表（彩色徽标）、结束报告
- **控制**：
  - 目标项目输入 + 浏览选择 + **「保存」默认路径**（写入配置，重启也默认使用）
  - **一键开始运行**：新项目自动初始化/扩写（目标 + 内置提示词 → Cursor 生成完整 FinalGoal/TODO）再执行；已初始化直接运行
  - 停止（写 STOP 文件优雅收尾）、**手动向 Cursor 发送消息**（人在回路/调试，未运行自动唤醒并等待回复）
  - 运行参数：任务上限 / 换号上限 / 线程轮转 / 进度检查点 / 最终验收（Apple 风格开关）
- **初始化状态圆点**：标题旁圆点颜色表示 已初始化(绿) / 部分完成(黄) / 需要初始化(红，自动展开) / 待输入(灰)
- **实时**：运行子进程日志流式回传（终端样式状态栏）；页面每 2 秒自动刷新状态/事件

说明：Web 固定「无人值守（live）」——`curloop web` **启动时自动提权**（非管理员运行会弹 UAC 确认一次，之后以管理员运行，live/换号直接可用）；服务只绑定 `127.0.0.1`。

## 长对话 / 记忆 / 可控 / 最终（Harness 设计）

- **长对话（真正的压缩）**：
  - `thread.rotate_every_tasks: 6`：每完成 6 个任务自动点「New Chat」开**新线程**，先固化记忆再发**续接提示词**
    （HARNESS_STATE.md + git + 剩余 TODO + FinalGoal），上下文有界、长跑不降质；0 = 保持单线程（默认）
  - `prompt.checkpoint_every_tasks: 5`：让 Agent 定期把进度小结写入 `HARNESS_STATE.md`
- **记忆（持久化）**：`HARNESS_STATE.md` 由 harness 在**每次结束**（run_done / 中断 / STOP / 中止 / 崩溃）自动生成
  （队列 + 账号 + 最近事件），任何新会话/恢复都有最低上下文；snapshot.json + events.jsonl 断点续跑不变
- **提示词（可定制）**：8 个内置模板（任务/扩展/重规划/首次规划/检查点/最终验收/续接/初始化扩写）注册在
  `PROMPT_DEFS`，Web「提示词」页可视化编辑；保存到 `%APPDATA%\curloop\prompts\<key>.txt` 即覆盖（清空 = 恢复内置）；
  `prompt.task_prompt_file` 可指定自定义任务提示词文件（`{project}` `{task}` `{retries}` 占位符）；
  `prompt.goal_in_task: true` 让任务提示词附带 FinalGoal 目标提示
- **自动换号**：撞 limit/登出自动换号（`login_assistant`），预算 `retry.max_total_account_switches_per_run`（0=不限）；
  CLI `--max-switches N` 可临时覆盖。0.3.1 起缩短 GUI 轮询/置顶 sleep，默认冷却 `retry.cooldown_between_switches_s: 8`
  （上限仍保留：`launch_wait_s` / `confirm_wait_s` / `switch_token_timeout_s`，命中即返回，不是睡满）。
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

默认配置开箱即用（Cursor / 换号助手路径未配置时会自动检测常见安装位置）。本机配置写在 `%APPDATA%\curloop\config.json`，自动合并并覆盖默认值。请存 **UTF-8 无 BOM**（记事本/PowerShell `Out-File` 常会写入 BOM，旧版会跳过该文件）。

```jsonc
{
  "project_dir": "D:\\your\\project",            // 目标项目（也可用 --project 指定，Web 可保存）
  "cursor": { "exe": "C:\\Program Files\\cursor\\Cursor.exe" },
  "login_assistant": {
    "exe": "C:\\Users\\you\\Desktop\\CursorLoginAssistant-836.exe",
    "refresh_template": "",                      // 留空 = 用内置模板（打包自带，无需自己截图）
    "confirm_template": "",
    "launch_wait_s": 20,                         // 等助手窗口出现的上限（秒），窗口一出来就继续
    "confirm_wait_s": 8
  },
  "timeouts": { "switch_token_timeout_s": 45 },  // 等 token 翻转上限
  "retry": { "cooldown_between_switches_s": 8 }  // 换号成功后的冷却（固定睡满；想更快可改 5）
}
```

换号助手的模板图片（`refresh_cursor.png` / `confirm_ok.png`）**内置打包**（`dist/assets/templates/`），
未配置时自动使用；检测报告与 Web「配置路径检测」页会显示当前来源（内置/已配置/自动检测）。

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
3. 促销/更新弹窗：`DISMISS_JS` 只在**可见** modal 内点白名单按钮（Not now / 取消 / 关闭…），绝不点 Update/订阅；
   `ensureReady` / `sendPrompt` 轮询关到 `modalCount==0`，等回复时每 3 轮再清一次
4. 撞限/掉线时自动换号：PowerShell 桥截图 → 纯 TS 模板匹配「刷新Cursor → 确认」→ 等 token 翻转 → 重启续跑
5. 每个任务完成后自动 `git commit`，队列动态吸收 Agent 追加的新任务

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
