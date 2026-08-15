# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**CursorHarness**（包名 `curloop`）是一个无人值守的 Cursor AI 自动化 Harness（Windows，**TypeScript**）。它通过 Chrome DevTools Protocol (CDP) 驱动**真实** Cursor 安装，实现：

1. 检测 Cursor 工作区 DOM 中的用量/速率限制、登录失效等 UI（中英文关键词）。
2. 撞到限制或登出时，驱动第三方 GUI 应用（换号助手 `CursorLoginAssistant-836.exe`）自动切换账号。
3. 重启 Cursor，按目标项目 `TODO.md` 复选框队列无人值守继续执行，完成任务后勾选 `[x]`。

Comments、README、CLI 输出与控制台字符串以**中文**为主；新增面向用户的文案请保持中文。

> ⚠️ 自动换号绕过用量限制违反 Cursor ToS。默认模式为 `dry-run`；`live` / `limit-sim` 需要显式开启**且以管理员（提权）shell 运行**。

## 技术栈与结构（纯 TypeScript / Node，零 Python）

- 构建：`npm run build`（tsc → `dist/`，并把 `src/win32.ps1`、`src/web/**` 复制到 `dist/`）；`npm run watch` 增量；`npm pack` 前自动 build。
- 入口：`bin/curloop.js`（Node）——flag 参数（`-` 开头）→ `dist/loop.js main()`；子命令/空 → `dist/cli.js main()`（REPL）。
- 运行时依赖：`ws`（CDP）、`minimist`（CLI 解析）、`proper-lockfile`（跨进程锁，异步）、`pngjs`（模板匹配）。
- **无任何 Python 残留**：仓库已删除全部 `.py`/`requirements.txt`/`runtime/`。`unattended/` 目录仅保留 3 个 `.bat` 启动器（自提权 + watchdog，ANSI/GBK + CRLF）。

## Commands（在 Harness 根 `D:\2026AppDev\CursorHarness`）

```bash
npm run build
node bin\curloop.js --check-config              # 只读配置自检
node bin\curloop.js --dry-run                   # 只读：TODO 队列 + CDP/auth/模板状态
node bin\curloop.js status                      # 状态面板（当前目录 = 目标项目）
node bin\curloop.js web                         # Web 界面（默认端口 3080，被占自动顺延）
node bin\curloop.js run --mode live --project D:\2026AppDev\RAGLab   # 无人值守（需管理员）
node bin\curloop.js run --mode limit-sim        # 换号链路测试（需管理员）
node bin\curloop.js --detect-only               # 附加 CDP Cursor，只轮询状态
node bin\curloop.js --inject-limit-node         # 向 DOM 注入假 limit 横幅（测试检测器）
node bin\curloop.js --assistant-refresh-only    # 杀 Cursor → 点刷新 → 等 token 翻转（管理员）
node bin\curloop.js plan                        # 只生成 TODO.md
node bin\curloop.js init --final-goal           # 生成 FinalGoal.md + TODO.md 模板
```

自提权启动器：`unattended\run_here.bat [live|limit-sim]`（复制到项目根双击）、
`unattended\run_unattended.bat [live|limit-sim] [--here] [--project <dir>]`、
`unattended\run_limit_sim.bat`。watchdog：异常退出自动重启（最多 5 次），run_done/abort/Ctrl-C 不重启。

## TypeScript 架构

- `src/cdp.ts` — CDP 核心：`CdpSession`（WebSocket JSON-RPC，`call`/`evaluate`）、`launchCursor`、`waitCdp`、
  `probePages`/`bestPage`/`sessionFor`、`tryFocusAndType`、`tryDismiss`。`PROBE_JS` 用已知选择器探测输入框。
- `src/auth.ts` — 只读探测 `state.vscdb`（`node:sqlite`，绝不打印完整 token）：`readAuthFromDb`/`waitAuthInDb`，
  DOM 登录门检测 `AUTH_GATE_JS`、`runConversation`（resume 语义）。
- `src/cursor.ts` — 唯一触碰真实 `%APPDATA%\Cursor` 配置的层：`init`（注入 CURSOR_EXE）、`dismissAll`/`dismissUntilClear`
  （`DISMISS_JS` 保守弹窗关闭）、`sendPrompt`/`clearComposer`、`pollReply`、`ensureReady`、`clickNewChat`（线程轮转用）。
- `src/detection.ts` — 三段注入 JS + 分类器：`buildLimitJs`/`classifyLimit`、`REPLY_JS`/`CompletionTracker`、
  `buildLogoutJs`。全部为 DOM 文本关键词匹配（EN + CN）。
- `src/prompts.ts` — 提示词 v2（注册表 + 可覆盖）：`PROMPT_DEFS`（8 个提示词：task/extend/goal_extend/
  plan_initial/checkpoint/final_verify/restore/expand_goal），每个都有内置模板 + 占位符（{project}/{task}/{goal}…）。
  用户可在 `%APPDATA%\curloop\prompts\<key>.txt` 覆盖（Web「提示词」页编辑保存；清空 = 恢复内置），
  发送时 `loadPrompt(key, builtin)` 优先读覆盖文件。构建器：`buildTaskPrompt`（任务纪律 + 仓库上下文 +
  可选 FinalGoal 目标提示 + `prompt.task_prompt_file` 旧机制兼容）、`CHECKPOINT_PROMPT`、`FINAL_VERIFY_PROMPT`、
  `buildRestorePrompt`（线程轮转/恢复续接）、`writeHarnessState`（harness 自动生成的 `HARNESS_STATE.md` 记忆文件）。
- `src/loop.ts` — 无人值守状态机 + flag CLI。`RunState`/`CompletionTracker`/`ensureIdleBeforeSend`/`waitReply`/
  `runTask`/`run`（Ctrl-C 秒级响应 + STOP 文件 + max_tasks 预算 + 三层收尾 + report.json）。
- `src/cli.ts` — 交互 CLI + REPL（run/plan/status/stats/watch/init/tasks/log/stop/report/web）。
- `src/web.ts` + `src/web/index.html` — Web 界面（Tabler 1.0 + ECharts 5 + marked，全部本地打包在
  `src/web/vendor/`，离线可用）。`/api/config` 可改运行参数（写入 `%APPDATA%\curloop\config.json` 并热重载）。
- `src/todoQueue.ts` / `src/runState.ts` / `src/observer.ts` / `src/ui.ts` / `src/fileLock.ts` — TODO 解析与勾选、
  断点续跑（snapshot + events.jsonl，5MB 轮转）、状态统计、ANSI 渲染、跨进程锁。
- `src/loginAssistant.ts` + `src/win32.ts` + `src/win32.ps1` — 换号助手 GUI 自动化：PowerShell 桥（Add-Type C#）
  窗口/截图/点击；`src/template.ts` 纯 TS 模板匹配（pngjs 灰度 + 降采样 NCC，语义对齐 pyautogui CCOEFF_NORMED）。
- `src/assistantProbe.ts` — 提权探测：以 `--remote-debugging-port=9355` 重启换号助手并导出其 DOM 到
  `%APPDATA%\curloop\runstate\assistant_probe.json`。

**历史**：2026-08 之前项目为 Python 核心 + npm 分发壳（postinstall 下载嵌入式 Python）。已被 TypeScript 重写取代，
相关代码与文档已全部移除，仅此一句作为历史记录。

## 关键不变量与注意事项

- **两个 profile 的边界**：无人值守驱动**真实** `%APPDATA%\Cursor`（config `cursor.profile`）；根目录 `.harness-profile`
  只是独立脚本/默认的隔离 profile。不要混用。
- **`killAllCursor` 只杀 `Cursor.exe`，绝不杀 `CursorLoginAssistant-836.exe`**。
- **`DISMISS_JS` 刻意保守**：只在**可见** modal 内点击，精确匹配安全短语白名单（`not now`/`later`/`取消`/`关闭`/…），
  **绝不**匹配 Update/Upgrade/Restart/订阅。没有 document-wide 兜底。X 关闭选择器同时匹配 `.cursor-modal-dismiss`/`.codicon-x`。
  新促销弹窗没被关掉时，把按钮文案加进 `cursor.ts` 的安全列表。
- **弹窗时机**：Cursor 在工作区加载后几秒才渲染 "Update recommended" 等，启动时一次性 dismiss 会漏掉。
  用 `dismissUntilClear(port, timeoutS, poll)`（轮询关到 `modalCount==0`）：`ensureReady` 30s 窗口、`sendPrompt` 8s 窗口、
  `waitReply` 每第 3 次轮询关一次。不要折叠成一次性关闭。
- **limit 检测必须新鲜**：`classifyLimit` 需要 `hard` 命中或 ≥2 关键词；`limitRequireRecent`（默认开）时，与上一轮
  完全相同的命中集视为常驻推销而非新 limit。不要放宽——否则常驻 "Upgrade to Pro" 横幅会触发换号。
- **完成检测没有魔法标记**：`CompletionTracker` 在最后一条 assistant 节点非空、逐字节一致、且非 busy 连续
  `completionStablePolls`（默认 8 ≈ 24s）轮询后判定 `done`；busy 时**绝不**硬超时（长 Agent 工具运行）。
  两道防线防过早排队：**`pairCount` 增长重置稳定计数**、**非空 composer（`composerText`）算 busy**。
  `thinking` 提示只扫**最后 3 条消息**，绝不扫 `document.body`（全页扫描会命中静态 UI 文本把 busy 钉死）。
  `isPromptEcho` 防把 prompt 回显当成回复。不要调低 `completionStablePolls`。
- **管理员必须**：`live` / `limit-sim` 需要提权（Cursor 与换号助手都要求 elevation，否则 WinError 740）。
  `run_unattended.bat` 自提权一次。保留 `isAdmin()` 门禁。
- **`isRunning` 匹配进程 stem 而非 `name.exe`**：`tasklist /NH` 会把镜像名截断到 25 字符。
- **`ensureDone`/`parseAll` 规范化 CRLF**：按规范化任务文案匹配（不是冻结行号）写回 `[x]`；`[-]` 视为取消。
- **中断与停止**：`loop.ts` 用模块级 `interruptRequested` + `sleepInterruptible` 实现 Ctrl-C 秒级响应——
  所有轮询循环（`waitReply`/`ensureIdleBeforeSend`/`sendAndWait`）**必须**用 `sleepInterruptible` + `checkInterrupt()`，
  不要在热循环里直接用 `sleep`。STOP 文件（`<projectDir>/STOP`，`control.stop_file` 可覆盖）存在即抛
  `StopRequested` → 记 run_abort、写 report、退出码 2（watchdog 不重启）。任务级 catch 必须 rethrow
  `HarnessInterrupt`/`StopRequested`。
- **运行预算与收尾**：`--max-tasks N` / `--max-switches N` 覆盖 `control.max_tasks` / `retry.max_total_account_switches_per_run`；
  任务提示词用 `buildTaskPrompt`（支持 `prompt.task_prompt_file` 覆盖，占位符 `{project}/{task}/{retries}`），
  不要再用 `TodoTask.prompt`。run_done/max_tasks/stop/abort 都写 `runstate/<key>/report.json`；可选三层收尾
  `prompt.final_verify`；长对话检查点 `prompt.checkpoint_every_tasks`；线程轮转 `thread.rotate_every_tasks`（0=关）。
- **记忆固化（`writeHarnessState`）**：`run_done`/`max_tasks`/`interrupt`/`stop`/`abort`/运行级错误**都必须**调用
  （与 `writeFinalReport` 并列），生成 `HARNESS_STATE.md`（队列 + 账号 + 最近事件）供新会话/恢复续接。
- **同步锁**：`fileLock.ts` 的 `withSyncLock`（独占创建锁文件 + mtime 陈旧检测）——`runState.log/save` 与
  `todoQueue.ensureDone` 热路径必须同步完成，不要改成异步 `withLock`（proper-lockfile 仅非热路径用）。
- **Web 界面**：`curloop web` 默认端口 3080（被占自动顺延 +1，最多 10 次）；静态资源走 `serveStatic`
  （URL 解码 + 去斜杠 + 越界 403）；`/api/config` 写 `%APPDATA%\curloop\config.json` 并热重载
  （`currentCfg` 可变引用，路由内用 `getCfg()`）。
- **配置外置**：`config.default.json`（干净默认）+ `%APPDATA%\curloop\config.json`（用户覆盖）+ `--config FILE`；
  runstate 默认 `%APPDATA%\curloop\runstate`，按（项目绝对路径, git 分支）隔离（`projectStateKey`）。
  **`cfg.projectDir` 可在 load 后被 CLI 覆盖，`todoFile`/`projectStateDir` 等必须是动态 getter**（见 config.ts fromDict）。
- **`*.bat` 必须保持 ANSI/GBK + CRLF，绝不能 UTF-8/LF**。cmd.exe 用系统 OEM 码页（此处 GBK）解析批处理；
  UTF-8 的 `.bat` 中文注释/echo 会乱码、截断命令、清空 `%MODE%`。编辑后必须按 GBK 重新保存。
