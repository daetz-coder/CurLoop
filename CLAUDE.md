# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**CursorHarness** is an unattended automation harness for the Cursor AI editor (Windows). It drives a **real** Cursor installation over Chrome DevTools Protocol (CDP) to:

1. Detect usage-limit / rate-limit / logged-out UI in the Cursor workbench DOM (English + Chinese keywords).
2. When a limit or logout is hit, automatically switch accounts by driving a third-party GUI app ("换号助手", `CursorLoginAssistant-836.exe`) via pyautogui template matching.
3. Restart Cursor and continue working through a checkbox queue parsed from a target project's `TODO.md`, marking items `[x]` on completion.

Comments, README, CLI output and console strings are predominantly **Chinese**; keep new user-facing strings in Chinese to match.

> ⚠️ Auto account-switching to bypass usage limits violates Cursor ToS. The default mode is `dry-run`; `live` / `limit-sim` require explicit opt-in **and an elevated (admin) shell**.

## Commands

No test framework, linter, or build step exists. No `requirements.txt`; dependencies are imported at runtime (`websockets`, `pyautogui`, optional `pywinauto`/`comtypes`/`wmi`). Verification is done with the `verify_*.py` scripts, which launch/attach Cursor and write JSON reports.

Run from the harness root `D:\2026AppDev\CursorHarness`:

```bash
# Config / read-only checks (no admin needed)
python -m unattended.loop --check-config
python -m unattended.loop --dry-run                 # list TODO queue + CDP/auth/template status
python -m unattended.loop --assistant-dry-run       # locate 换号助手 window/templates, no click
python -m unattended.loop --detect-only             # attach to CDP-enabled Cursor, poll state only

# Real switch-chain test (admin): kill Cursor -> click 刷新Cursor -> confirm -> wait token flip -> relaunch
python -m unattended.loop --mode limit-sim

# True unattended run (admin)
python -m unattended.loop --mode live --project D:\2026AppDev\RAGLab

# Other flags (loop.py):
python -m unattended.loop --assistant-refresh-only  # kill Cursor, really click 刷新Cursor, wait token flip (admin)
python -m unattended.loop --inject-limit-node       # inject a fake limit banner into DOM to test the detector
python -m unattended.loop --detect-only --detect-seconds 30

# Self-elevating batch launchers (UAC on first start)
unattended\run_here.bat [live|limit-sim]   # ONE file: copy into a project root, double-click -> opens Cursor with CDP 9333 on THAT folder (or attaches if already running), then runs the unattended loop (tasks / dismiss modals / account switch / watchdog / no-sleep)
unattended\run_unattended.bat [live|limit-sim] [--here] [--project <dir>]
#   --here = use the CURRENT directory as the project (cd into the project first)
#   watchdog: auto-restarts on crash (max 5), not on run_done/abort/Ctrl-C;
#   as admin it also disables system sleep (standby-timeout-ac 0) for long runs
unattended\run_limit_sim.bat         # convenience wrapper for limit-sim
```

Standalone / verification scripts (all attach to CDP on port 9333 unless `--port` is given):

```bash
python verify_cdp.py --launch --submit --out verify-report.json   # smoke: launch+probe+type
python verify_actions.py                                           # second pass: click New Chat, re-probe inputs
python resume_after_auth.py --relaunch                             # wait auth -> chat until marker
python detect_limit.py --once                                     # classify limit/logged_out/generating
python verify_conversation.py                                     # send HARNESS_OK prompt, wait reply
python verify_conversation_verdict.py                             # re-classify last conversation report
```

## TypeScript 架构（2026-08 重构：TypeScript 重写版，纯 Node，零 Python 依赖）

> 分支 `feature/ts-rewrite`：核心已从 Python 重写为 TypeScript。**新开发一律在 `src/*.ts` 进行**，
> `unattended/*.py` 是旧实现，仅作参考/回归对比，不要再改。

- 构建：`npm run build`（tsc → `dist/`），`npm run watch` 增量编译，`npm pack` 前自动 build（prepack）。
- 入口：`bin/curloop.js`（Node）——flag 参数（`-` 开头）→ `dist/loop.js main()`；子命令/空 → `dist/cli.js main()`（REPL）。
- 运行时依赖：`ws`（CDP）、`minimist`（CLI 解析）、`proper-lockfile`（跨进程锁，异步）、`pngjs`（模板匹配）。
- **同步锁**：`src/fileLock.ts` 提供 `withSyncLock`（独占创建锁文件 + mtime 陈旧检测）——runState.log/save 与 todoQueue.ensureDone
  在热路径必须同步完成，不要改成异步 `withLock`（proper-lockfile 是异步的，只有非热路径才用）。
- **win32 桥**：`src/win32.ps1`（Add-Type C#：窗口/截图/点击）经 `src/win32.ts` 包装，`src/template.ts` 纯 TS 模板匹配
  （pngjs 灰度 + 降采样 NCC，语义对齐 pyautogui CCOEFF_NORMED）。
- 关键映射（Python → TS）：`loop.py`→`src/loop.ts`、`cli.py`→`src/cli.ts`、`todo_queue.py`→`src/todoQueue.ts`、
  `run_state.py`→`src/runState.ts`、`observer.py`→`src/observer.ts`、`ui.py`→`src/ui.ts`、
  `verify_cdp.py`→`src/cdp.ts`、`resume_after_auth.py`→`src/auth.ts`、`cursor_ctl.py`→`src/cursor.ts`、
  `detection.py`→`src/detection.ts`、`login_assistant.py`→`src/loginAssistant.ts`、`assistant_probe.py`→`src/assistantProbe.ts`；
  新增 `src/prompts.ts`（提示词 v2：任务纪律+仓库上下文、长对话检查点、最终验收）、
  `src/web.ts` + `src/web/index.html`（Web 界面，仿 dsh web）。
- **Web 界面（`curloop web`）**：纯 Node 内置模块 HTTP 服务器，只绑定 127.0.0.1；默认端口 3080，
  **被占自动顺延（EADDRINUSE → +1，最多 10 次）**——本机 dsh web 就占着 3080。静态页在 `src/web/index.html`
  （构建时 `cpSync` 到 `dist/web/`，build 脚本里与 win32.ps1 一起复制）。**UI 用 Tabler 1.0（Bootstrap 5 暗色）
  + ECharts 5，库文件本地打包在 `src/web/vendor/`（离线可用，勿删）**；页面 JS 内联在 HTML（`new Function` 可做
  语法检查），图表在客户端由 events.jsonl 渲染。**静态路由在 `web.ts` 的 `serveStatic`（解码 + 去斜杠 + 越界 403）**，
  新增资源（vendor/xxx）无需改路由。运行/规划通过**子进程** `node bin/curloop.js run|plan --project …` 执行，
  stdout 进内存环形缓冲（`/api/console?since=N` 轮询回传），STOP 文件优雅停止。API：`/api/status` `/api/events`
  `/api/snapshot` `/api/report` `/api/console` `/api/run` `/api/plan` `/api/stop` `/api/init` `/api/ask`。
  live/limit-sim 需服务本身是管理员（`isAdmin()` 门禁）。
- **中断与停止（可控性）**：`loop.ts` 用模块级 `interruptRequested` + `sleepInterruptible`（已导出，供测试）
  实现 Ctrl-C 秒级响应——所有轮询循环（waitReply / ensureIdleBeforeSend / sendAndWait）**必须**用
  `sleepInterruptible` + `checkInterrupt()`，不要在热循环里直接用 `sleep`，否则 Ctrl-C 要等一个轮询周期。
  STOP 文件（`<projectDir>/STOP`，`control.stop_file` 可覆盖）存在即抛 `StopRequested` → run() 记
  run_abort、写 report、退出码 2（watchdog 不重启）。任务级 catch 必须 rethrow
  `HarnessInterrupt`/`StopRequested`，绝不能当 task_error 吞掉。
- **运行预算与收尾**：`--max-tasks N` / `--max-switches N`（CLI 覆盖 `control.max_tasks` /
  `retry.max_total_account_switches_per_run`）；任务提示词用 `buildTaskPrompt`（git 上下文 + 工作纪律，
  支持 `prompt.task_prompt_file` 文件覆盖，占位符 `{project}/{task}/{retries}`），不要再调 `TodoTask.prompt`。
  run_done / max_tasks / stop / abort 都写 `runstate/<key>/report.json`（`writeFinalReport`）；可选三层收尾
  `prompt.final_verify`（tryFinalVerify，在 level-1 extend 与 level-2 goal_extend 之后），长对话检查点
  `prompt.checkpoint_every_tasks`（每 N 任务让 Agent 写 HARNESS_STATE.md）。
- **记忆固化（writeHarnessState）**：`prompts.ts` 里 harness 自动生成 `HARNESS_STATE.md`（队列+账号+最近事件），
  **run_done / max_tasks / interrupt / stop / abort / 运行级错误都必须调用**（与 writeFinalReport 并列）；
  线程轮转 `thread.rotate_every_tasks`（0=关）每 N 任务走 `rotateThread`：写记忆 → `cursor.clickNewChat` →
  发 `buildRestorePrompt`（记忆+git+剩余 TODO）→ `ensureIdleBeforeSend` 等 Agent 处理完，失败不致命（回落单线程）。
- 配置外置不变：`config.default.json`（干净默认）+ `%APPDATA%\curloop\config.json`（用户覆盖）+ `--config FILE`；
  runstate 默认 `%APPDATA%\curloop\runstate`，按 (项目绝对路径, git 分支) 隔离（`projectStateKey`）。
  **`cfg.projectDir` 可在 load 后被 CLI 覆盖，`todoFile`/`projectStateDir` 等必须是动态 getter**（见 config.ts fromDict），
  不要缓存成固定值——否则 `curloop status`/`run --project X` 会读错 runstate 目录。
- TS 命令行验证（cd 到仓库根）：
  ```bash
  npm run build
  node bin\curloop.js --check-config          # 只读配置自检
  node bin\curloop.js --dry-run               # 只读：TODO 队列 + CDP/auth/模板状态
  node bin\curloop.js status                  # 状态面板（当前目录 = 目标项目）
  node bin\curloop.js run --mode limit-sim    # 换号链路测试（管理员）
  node bin\curloop.js run --mode live --project D:\2026AppDev\RAGLab   # 无人值守（管理员）
  ```
- `*.bat`（run_unattended/run_here/run_limit_sim/curloop.cmd/harness.bat）已改为调用 `node bin\curloop.js`，
  仍必须是 **ANSI/GBK + CRLF**（cmd.exe 用系统 OEM 码页解析），编辑后要按 GBK 重新保存。

## npm 分发（2026-08 之前：Python 核心不动，外壳层用 npm 分发）

> 历史方案（Python 核心 + npm 分发壳）已被 TypeScript 重写取代。以下仅作历史参考：
> postinstall 下载嵌入式 Python（python-build-standalone 3.12，`<pkg>/runtime/python/`）并 pip 安装，
> `bin/*.js` 是 Node shim 透传 `python -m unattended.loop` / `harness.py`。此路径不再维护。

## Architecture

Cursor is never "driven" natively — **everything goes through CDP**: launch Cursor with `--remote-debugging-port=9333 --user-data-dir=<real profile>`, then `Runtime.evaluate` injected JS snippets against the workbench page. Reuse the CDP layer as a library (parent-dir import) rather than duplicating it.

- **`verify_cdp.py`** (root) — the shared CDP core: `CdpSession` (WebSocket JSON-RPC wrapper with `call`/`evaluate`), `launch_cursor`, `wait_cdp`, `list_targets`, `probe_pages`, `try_focus_and_type` (focus composer, Ctrl-A, `Input.insertText`, optional Enter), `try_dismiss`. `PROBE_JS` selects chat inputs via known selectors (`.aislash-editor-input`, Lexical editor, etc.). Default profile is the isolated `.harness-profile`; port 9333 (deliberately not 9222).
- **`resume_after_auth.py`** (root) — auth-wait + relaunch + conversation. Reads Cursor auth from `state.vscdb` (sqlite3 read-only, never prints tokens); waits until the DOM no longer shows the logged-out gate; runs a chat until a marker appears. Imports `verify_cdp` as a library — the pattern `cursor_ctl` follows too.
- **`detect_limit.py`** (root) — read-only monitor: classifies screen state (`ok` / `usage_or_rate_limit` / `maybe_limit_weak` / `logged_out` / `generating`) from DOM text.
- **`verify_actions.py`** (root) — second-pass smoke: click New Chat then re-probe chat inputs; writes `verify-actions.json`.
- **`unattended/`** — the actual product package (`python -m unattended.loop`):
  - `loop.py` — CLI + the state machine. Flow: `ENSURE_RUNNING → SEND (same chat thread, no New Agent) → WAIT_REPLY`; on `done` mark the TODO `[x]` and `_git_commit`; on `limit`/`logged_out` switch account; on `no_page`/`cdp_error`/`hard_timeout` relaunch (up to `hang_retries_per_task`) then switch; switch budget bounded by `retry.max_total_account_switches_per_run`. **Goal-driven queue** (`retry.auto_extend`, `auto_plan_todo`, `final_goal_file`): if `TODO.md` is missing, read `<project>/FinalGoal.md` and ask the agent to create the initial plan; when the queue drains, level-1 light auto-extend plans from current state; only if that finds nothing does level-2 re-read FinalGoal and re-plan (large goal, so not re-read on every drain); the run stops when both levels add no tasks (goal done). Ctrl-C saves state and exits 130 for resume. **周期状态块**（CLI 可视化，`config.ui.periodic_status_s` 默认 180s，0 关闭）：主循环定时 `print(ui.status_render(observer.build_status(...)))`——非全屏、不遮挡换号助手窗口，这是本分支替代 master TUI 仪表盘的方案。
  - `cursor_ctl.py` — the only module that touches the **real** `%APPDATA%\Cursor` profile. Wraps `verify_cdp`/`resume_after_auth`. `init()` monkey-patches `verify_cdp.CURSOR_EXE` from config and raises the CDP HTTP timeout (2s → 6s). Holds `DISMISS_JS` (safe modal dismissal) + `dismiss_all`/`dismiss_until_clear` (poll-dismiss until modals are gone — modals render late after workbench load), `send_prompt`, `poll_reply`, `ensure_ready`, `auth_fp`/`wait_token_change`.
  - `detection.py` — the three injected JS snippets + Python classifiers: `build_limit_js`/`classify_limit`, `REPLY_JS`/`CompletionTracker`, `build_logout_js`. All detection is DOM-text keyword matching, EN + CN.
  - `login_assistant.py` — GUI automation for 换号助手: move window to primary monitor, pyautogui `locateOnScreen`/`click` on `refresh_cursor.png` then `confirm_ok.png`, optional pywinauto UIA fallback. `dry_run=True` locates only. Window lookup is exe-process based (`find_windows_for_exe`, title-independent) with title-fragment fallback + diagnostic title dump when not found; launch failures (WinError 740 etc.) and early exits are reported; after a real refresh the assistant is closed via `close_assistant` (WM_CLOSE + kill fallback, gated by config `close_after_refresh`). Token-change detection is the caller's job (`_do_switch` in loop.py).
  - `todo_queue.py` — `- [ ]`/`- [x]`/`- [X]`/`- [-]` checkbox parsing → `TodoTask` queue；`[-]` 视为取消（done，不入队）；`ensure_done`/`mark_done` 按规范化文案写回 `[x]`（保留 CRLF）。重复文案保留首次并 stderr 警告。
  - `run_state.py` — `runstate/snapshot.json`（断点续跑）+ `events.jsonl`（追加日志，超 5MB 轮转 `.1`…`.3`；`observer.load_events` 会合并轮转段）。`load` 与 TODO.md 合并：文件已勾选→done、用户反勾选→重新 pending、追加新未勾选项、**skipped→pending**（避免假完成）。写路径用 `file_lock.FileLock`。
  - **runstate 按 (项目绝对路径, git 分支) 隔离**：key = `runstate/<slug>@<分支>_<路径短哈希>/`（`config.project_state_key`；`current_branch` 读 `.git/HEAD` 零子进程；detached→短 hash、linked worktree→gitdir 解析、非 git→default）。`config.project_state_dir` 与 `observer._state_key` 必须同源（都调 `project_state_key`）。
  - `config.py` / `config.default.json` — typed runtime config (paths, detection keywords, timeouts, retry budget). **npm 分发后配置外置**：仓库内 `config.default.json` 是干净默认（不含任何本机路径），`Config.load()` 按 默认配置 → `%APPDATA%\curloop\config.json`（用户覆盖）→ `--config FILE`（最高优先）合并；Cursor.exe 与换号助手 exe 未配置时自动检测（`_detect_cursor_exe`/`_detect_assistant_exe`）。`--project` CLI override sets the module global `PROJECT_OVERRIDE` before load. runstate 默认外置到 `%APPDATA%\curloop\runstate`。
  - `assistant_probe.py` — elevated probe: relaunch 换号助手 with `--remote-debugging-port=9355` and dump its DOM to `%APPDATA%\curloop\runstate\assistant_probe.json`。exe 路径自动检测（Desktop/Downloads），可用 `--exe <路径>` 覆盖，无硬编码用户名。`win_ocr.ps1` — Windows OCR helper used for screenshot text extraction.

## Key invariants & gotchas

- **Two profiles.** `unattended/` drives the **real** `%APPDATA%\Cursor` (config `cursor.profile`). The isolated `.harness-profile` in the repo root is only the default for the standalone root `verify_*.py` scripts. Don't switch one for the other.
- **`kill_all_cursor` kills every `Cursor.exe`, never `CursorLoginAssistant-836.exe`.** Same in `kill_cursor_for_profile`.
- **`DISMISS_JS` is deliberately conservative**: it only clicks inside **visible** modals, matches an exact allow-list of safe phrases (`not now`/`later`/`取消`/`关闭`/…), and **never** matches Update/Upgrade/Restart/订阅 buttons. There is intentionally no document-wide fallback — document-wide text scanning previously clicked unrelated "关闭" elements. X-close selector also matches `.cursor-modal-dismiss`/`.codicon-x` (Cursor's real modal X has class `cursor-modal-dismiss codicon codicon-x`, not `codicon-close`). If a new promo modal isn't dismissed, add its button text to the safe lists in `cursor_ctl.py`.
- **Modal timing: Cursor renders "Update recommended" etc. only a few seconds after the workbench loads**, so a single `dismiss_all` at startup misses them. Use `dismiss_until_clear(port, timeout_s, poll)` (poll-dismiss until `modalCount==0`): `ensure_ready` runs a 30s window, `send_prompt` an 8s window, and `_wait_reply` dismisses every 3rd poll. Don't collapse these back to one-shot dismiss.
- **Limit detection must be fresh.** `classify_limit` requires a `hard` match or ≥2 keyword hits; with `limit_require_recent` (default true) a hit-set identical to the previous poll is treated as a persistent upsell, not a new limit. Don't weaken this or always-visible "Upgrade to Pro" banners will trigger account switches.
- **Completion detection has no magic marker.** `CompletionTracker` declares `done` when the last assistant node is non-empty, byte-identical, and not busy for `completion_stable_polls` (default 8 ≈ 24s) consecutive polls; it **never** hard-timeouts while `busy` (long Agent tool runs). Two extra guards prevent queueing the next prompt too early: **`pairCount` growth restarts the stable count** (a new message pair = another reply started), and **a non-empty composer (`composerText`) counts as busy** (unsent/queued input = previous reply not finished). The `thinking` hint is scoped to the **last 3 messages only** — never `document.body`, because whole-body scans match static UI text (e.g. a git-timeline commit message "…related planning files" hits `planning`) and pin `busy=True` forever. `loop._is_prompt_echo` guards against the composer echo of the prompt being mistaken for a reply (disqualifies the stable count). Don't lower `completion_stable_polls` — Cursor agent replies pause mid-stream (thinking/tool runs) and 4 polls (12s) was observed to falsely declare done and pile prompts into Cursor's queue.
- **Admin is required** for `live` / `limit-sim` (Cursor and 换号助手 both demand elevation; otherwise `WinError 740`). `run_unattended.bat` self-elevates once. Keep the `_is_admin()` gate.
- **`is_running` matches the process stem, not `name.exe`**, because `tasklist /NH` truncates image names to 25 chars.
- **pywinauto/comtypes typelib generation is flaky on this box** — it's a guarded optional fallback behind the pyautogui template path. Don't make it the primary path.
- **`mark_done`/`ensure_done` and `parse_all` normalize CRLF** so line endings stay predictable; writeback uses bytes. Matching is by normalized task text (not frozen line number). `[-]` is cancelled/done.
- **Console is set to UTF-8** (`SetConsoleOutputCP(65001)` in `loop._setup_console`) to avoid GBK mojibake for Chinese output.
- **`*.bat` files must stay ANSI/GBK + CRLF, never UTF-8/LF.** cmd.exe parses batch files with the system OEM codepage (GBK here); a UTF-8 `.bat` with Chinese comments/echo garbles parsing, truncates commands (`'f-elevates' 不是内部或外部命令`…), empties `%MODE%` and breaks the `cd` — `python -m unattended.loop` then fails with `ModuleNotFoundError`. If a `.bat` must be edited, re-save it as ANSI (or GBK) with CRLF line endings.
