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

## npm 分发（2026-08 重构：Python 核心不动，外壳层用 npm 分发）

项目本体是 Python（仅 Windows），npm 只做**分发壳**：`postinstall` 自动下载嵌入式 Python
（python-build-standalone 3.12，`<pkg>/runtime/python/`，gitignore 不入库）并 `pip install -r requirements.txt`，
`bin/*.js` 是 Node shim——保持当前 cwd、`PYTHONPATH` 指向包根、透传参数/stdio/退出码。

```bash
npm install                 # 仓库根：postinstall 下载嵌入式 Python + 装依赖（可设 CURSOR_HARNESS_PYTHON_URL 换镜像）
npm link                    # 注册全局命令（本地验证）
curloop --check-config       # 等价 python -m unattended.loop（flag 参数直通）
curloop status                  # 等价 python harness.py（cwd = 目标项目）
npm pack                    # 打发布包（files 白名单，排除 runtime/、__pycache__、runstate）
```

- 关键文件：`package.json`（bin: curloop，os: win32，files 白名单）、`bin/_common.js`（shim 公共逻辑）、
  `bin/curloop.js`（合并入口：flag 参数→loop 直通，子命令/空→交互 CLI）、`scripts/install.js`（下载+解压嵌入式 Python，tar npm 包解压，内容上移一层）、`requirements.txt`。
- 嵌入式 Python 锁定版本 `3.12.13`（python-build-standalone release `20260807`，install_only_stripped 约 21MB）。
- **`*.bat` 不进 npm 包**（GBK/CRLF 本地开发仍可用），分发入口以 bin 命令为准。
- 配置与运行状态外置：默认 `config.default.json` + `%APPDATA%\curloop\config.json`（用户覆盖）+ 自动检测路径，
  runstate 默认 `%APPDATA%\curloop\runstate`。详见下方 `config.py` 条目。

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
  - `assistant_probe.py` — elevated probe: relaunch 换号助手 with `--remote-debugging-port=9355` and dump its DOM to `runstate/assistant_probe.json`. `win_ocr.ps1` — Windows OCR helper used for screenshot text extraction.

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
