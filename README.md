# ♻️ curloop — Unattended Cursor harness

**English** | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/curloop.svg)](https://www.npmjs.com/package/curloop)
[![npm downloads](https://img.shields.io/npm/dm/curloop.svg)](https://www.npmjs.com/package/curloop)
[![node](https://img.shields.io/node/v/curloop.svg)](https://www.npmjs.com/package/curloop)
[![platform](https://img.shields.io/badge/platform-Windows-0078D4.svg)](https://github.com/daetz-coder/CurLoop)
[![license](https://img.shields.io/npm/l/curloop.svg)](LICENSE)

> **Drive the real Cursor IDE from a TypeScript harness: walk a `TODO.md` checkbox queue unattended, detect usage limits / signed-out UI, switch accounts via a login-assistant GUI, then restart and resume.** One product-grade Web console replaces hopping between CLI, logs, and the IDE.

curloop (this repo is **CursorHarness**) attaches to a **real** Cursor install over Chrome DevTools Protocol (CDP). It is **Windows + Node.js ≥ 22.13 only**, with **zero Python**. Default mode is `dry-run`; live account switching needs `--mode live` (the Web UI is always live and self-elevates via UAC).

> ⚠️ Auto-switching accounts to bypass Cursor usage limits **violates Cursor ToS**. Accounts can be rate-limited or banned. You run this at your own risk.

## ✨ What it does

| Capability | Description |
|------------|-------------|
| 🎯 **TODO queue** | Parses the target project's `TODO.md` checkboxes, sends one task at a time, ticks `[x]` when done, and absorbs new items the Agent appends |
| 🖥️ **Real Cursor** | Launches / attaches Cursor with `--remote-debugging-port`, types into the real composer, polls the real reply |
| 🔁 **Account switch** | On limit / logout, kills Cursor, clicks the login-assistant **Refresh Cursor** + confirm templates, waits for token flip, then continues |
| 🧭 **Web console** | `curloop web` — Tabler + ECharts, fully offline (`src/web/vendor/`). Overview, console, timeline, queue, events, report, config, prompts |
| 🧠 **Memory** | Writes `HARNESS_STATE.md` on every exit; optional thread rotate + checkpoints so long runs stay bounded |
| 🛑 **Control** | `--max-tasks` / `--max-switches`, `STOP` file, Ctrl-C that returns in seconds, `report.json` after every run |

## 🚀 30-second quick start

```bash
# 1. Install (Windows, Node ≥ 22.13)
npm install -g curloop
# If you still have 0.1.x (Python shell, no `web` command):
#   npm uninstall -g curloop && npm install -g curloop

# 2. Sanity-check config (read-only)
curloop --check-config

# 3. Open the Web console (UAC once if not already admin)
curloop web
```

Or run unattended from a project root that already has `TODO.md`:

```bash
curloop run --mode live --project D:\path\to\project
curloop run --mode live --max-tasks 10 --max-switches 3
```

Two entry styles, auto-detected:

- **Flag passthrough** — first arg starts with `-` (`--check-config` / `--dry-run` / `--detect-only` / `--mode …`)
- **Interactive CLI** — no args opens a REPL, or subcommands `run` / `plan` / `status` / `stats` / `watch` / `init` / `tasks` / `log` / `stop` / `report` / `web`

REPL slashes: `/status` `/stats` `/tasks` `/log [N]` `/run` `/plan` `/watch` `/init` `/stop` `/report` `/project <path>` `/exit`.

## Why this approach

- **The IDE is the real product**: no unofficial Cursor API. CDP injects JS into the workbench DOM, types into the composer, and classifies limit / logout / completion from **EN + CN keywords**.
- **Dismiss is conservative**: `DISMISS_JS` only clicks **visible** modals against a safe whitelist (`Not now` / `Later` / `取消` / `关闭` / …). It **never** matches Update / Upgrade / Restart / Subscribe. Promo banners that appear a few seconds after workspace load are polled until `modalCount == 0`.
- **Tokens stay private**: `state.vscdb` is read with `node:sqlite`; logs only print a fingerprint, never the full access token.
- **Switch waits are ceilings, not sleeps**: `launch_wait_s` / `confirm_wait_s` / `switch_token_timeout_s` return as soon as the window / template / token is ready. The one fixed wait is `retry.cooldown_between_switches_s` (default **8s** since 0.3.1).
- **Two profiles never mix**: unattended drives real `%APPDATA%\Cursor`. The repo `.harness-profile` is an isolated default, not the live profile.

## Directory layout

```
bin/curloop.js                 # Node entry (flags → loop; subcommands → CLI / web)
src/
  cdp.ts                       # CDP WebSocket (ws): launch / attach / evaluate / type
  auth.ts                      # read-only state.vscdb + DOM login gate
  cursor.ts                    # dismiss / send / poll / ensure-ready
  detection.ts                 # limit / logout / completion classifiers (injected JS)
  loginAssistant.ts            # GUI automation for CursorLoginAssistant-836.exe
  win32.ts + win32.ps1         # PowerShell bridge (Add-Type C#): window / screenshot / click
  template.ts                  # pngjs grayscale + downsampled NCC (CCOEFF_NORMED-like)
  prompts.ts                   # 8 overridable prompt templates
  loop.ts / cli.ts / web.ts    # state machine, REPL, HTTP UI
  web/                         # Tabler + ECharts + marked (vendored, offline)
  assets/templates/            # built-in refresh_cursor.png / confirm_ok.png
unattended/*.bat               # self-elevate + watchdog (ANSI/GBK + CRLF)
config.default.json            # clean defaults; user overlay in %APPDATA%\curloop\config.json
```

`unattended/*.bat` always enter through `bin/curloop.js` → `dist/`. Batches **must** stay ANSI/GBK + CRLF (cmd.exe OEM code page).

## Web console

```bash
curloop web                     # default port 3080, +1 if busy (up to 10 tries)
curloop web --port 8080
curloop web --no-open           # serve only, do not open a browser
```

Bound to `127.0.0.1` only. Starting `curloop web` **self-elevates** (one UAC prompt) so live / account-switch work without a second admin shell.

In the browser you get the full CLI surface:

- **Overview** — switches / sends / done / resumes; ECharts timeline (task bars + switch marks, wheel-zoom) and 24h activity
- **Control** — pick a project (browse + **Save** as default), one-click run (new projects auto-init / expand FinalGoal + TODO), STOP file, human-in-the-loop “send to Cursor”
- **Init status dot** — green / yellow / red / gray next to the title
- **Prompts** — edit the 8 templates; saved to `%APPDATA%\curloop\prompts\<key>.txt` (empty file = restore builtin)
- **Live log** — child-process stdout streamed into a terminal strip; status/events refresh every 2s

## Harness design (memory / switch / control / finish)

- **Long context, actually bounded**
  - `thread.rotate_every_tasks: 6` — after N tasks, click New Chat, dump memory, send a restore prompt (`HARNESS_STATE.md` + git + remaining TODO + FinalGoal). `0` = stay on one thread (default)
  - `prompt.checkpoint_every_tasks: 5` — ask the Agent to write a progress note into `HARNESS_STATE.md`
- **Memory** — `HARNESS_STATE.md` is written on every exit (`run_done` / interrupt / STOP / abort / crash). Snapshot + `events.jsonl` still do crash-resume
- **Prompts** — registry in `PROMPT_DEFS` (task / extend / goal_extend / plan_initial / checkpoint / final_verify / restore / expand_goal). Optional `prompt.task_prompt_file` with `{project}` `{task}` `{retries}`. `prompt.goal_in_task: true` appends FinalGoal to every task
- **Account switch** — budget `retry.max_total_account_switches_per_run` (`0` = unlimited). CLI `--max-switches N` overrides. From 0.3.1: shorter GUI poll / foreground sleeps; default cooldown `8`
- **Control**
  - `--max-tasks N` / `control.max_tasks` — stop after N completed tasks (exit 0)
  - **STOP file** (`<projectDir>/STOP`, or `control.stop_file`) — graceful abort, exit 2 (watchdog does not restart). REPL `/stop` creates it
  - Ctrl-C: all poll loops use interruptible sleep, persist state, exit 130
- **Finish** — empty queue + light extend + FinalGoal replan all yield nothing → done. Optional `prompt.final_verify`. Every normal end writes `runstate/<key>/report.json`

## Config

Defaults work out of the box (Cursor / login-assistant paths are auto-detected when unset). User overlay: `%APPDATA%\curloop\config.json` (merged on top of `config.default.json`). Save as **UTF-8 without BOM** (Notepad / PowerShell `Out-File` often write a BOM; older builds skip the file).

```jsonc
{
  "project_dir": "D:\\your\\project",            // also --project; Web can persist this
  "cursor": { "exe": "C:\\Program Files\\cursor\\Cursor.exe" },
  "login_assistant": {
    "exe": "C:\\Users\\you\\Desktop\\CursorLoginAssistant-836.exe",
    "refresh_template": "",                      // empty = packed builtin
    "confirm_template": "",
    "launch_wait_s": 20,                         // ceiling; continues as soon as the window exists
    "confirm_wait_s": 8
  },
  "timeouts": { "switch_token_timeout_s": 45 },  // ceiling for token flip
  "retry": { "cooldown_between_switches_s": 8 }  // the one fixed sleep after a successful switch
}
```

Refresh/confirm templates ship in `dist/assets/templates/`. Runstate lives in `%APPDATA%\curloop\runstate` (keyed by absolute project path + git branch).

## Target project format

Put `TODO.md` at the project root:

```markdown
- [ ] Task one
- [x] Already done
- [ ] Task two
```

Optional `FinalGoal.md` describes the end state. When the queue empties, curloop light-extends from current work, then replans against FinalGoal. If both pass produce no new items, the run is complete.

## How it works

1. Launch / attach real Cursor with `--remote-debugging-port=9333` (real `%APPDATA%\Cursor`)
2. Inject JS: usage/rate-limit, signed-out, reply-complete (EN + CN keywords)
3. Promo / update modals: whitelist click inside visible dialogs; `ensureReady` / `sendPrompt` poll until clear; every 3rd reply poll dismisses again
4. On limit / logout: screenshot via PowerShell → NCC template match “Refresh Cursor → Confirm” → wait for token flip → relaunch and continue
5. After each task, `git commit`; new checkboxes the Agent added are picked up on the next loop

## Distribution & install

### Channel 1: npm (recommended)

```bash
npm install -g curloop
curloop web
curloop run --mode live --project D:\path\to\project
```

Maintainer publish: `npm publish` (unscoped public package `curloop`).

### Channel 2: run from this repo (development)

```bash
git clone git@github.com:daetz-coder/CurLoop.git
cd CurLoop
npm install
npm run build        # tsc → dist/
npm link             # global `curloop` points at this directory
```

`npm run watch` for incremental compile. `npm pack` / `npm publish` run `prepack` → `npm run build`.

### Channel 3: unattended launchers

Copy `unattended\run_here.bat` to a project root and double-click (`live` or `limit-sim`). `run_unattended.bat` self-elevates once; watchdog restarts on crash (max 5), but not on `run_done` / abort / Ctrl-C.

## License

[MIT](LICENSE)
