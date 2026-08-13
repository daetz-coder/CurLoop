# unattended —— 无人值守 Cursor 编码循环

在 Cursor 碰到用量限制（usage limit 弹窗/横幅）时，自动换号、重启、续接原会话继续干活。
驱动的是**真实 Cursor 配置**（`%APPDATA%\Cursor`），任务队列来自目标项目里的 `TODO.md` 复选框。

> ⚠️ 自动轮号绕过用量限制违反 Cursor 的 ToS，账号存在风控/封禁风险。本工具默认 `dry-run`，
> 所有会真实换号的操作都要你显式指定 `--mode live / limit-sim`，且**必须以管理员运行**。

## 快速开始（推荐：单文件一键）

把 `unattended\run_here.bat` **复制到目标项目根目录**，双击（UAC 点"是"）。它会自动：

1. 以调试端口 9333 启动/附加 Cursor（绑定当前目录）
2. **目标驱动**：若项目无 `TODO.md`，读取项目根的 `FinalGoal.md` + 提示词，让 Agent 生成初始规划
3. 执行 TODO 任务（自动关弹窗 / 自动换号 / 每完成一个任务自动 `git commit`）
4. 队列空 → 轻量 auto_extend 续任务 → 轻量无新任务时再对照 FinalGoal 重规划
5. 目标完成（两层规划都无新任务）→ 停止

## 使用

```bash
# 1) 改配置（项目路径、换号助手、模板、关键词、超时……）
#    编辑 unattended/config.json；项目目录也可用 --project 覆盖

# 2) 只读检查（不需要管理员）
python -m unattended.loop --check-config
python -m unattended.loop --dry-run                 # 列出 TODO 队列 + CDP/登录态/模板状态

# 3) 定位换号助手窗口/模板，不点击（不需要管理员，但助手要在运行才找得到）
python -m unattended.loop --assistant-dry-run

# 4) 连上已带调试端口运行的 Cursor，只看检测状态，不发送（只读）
python -m unattended.loop --detect-only

# 5) 真实换号链路测试（需要管理员）：杀 Cursor → 点"刷新Cursor"→ 确认 → 等 token 变化 → 重启 → 续跑
python -m unattended.loop --mode limit-sim
#    （会真实点击换号助手并切换账号；第一个任务会在等待时强制触发一次换号）

# 6) 真正无人值守（需要管理员）
python -m unattended.loop --mode live --project D:\2026AppDev\RAGLab
```

管理员方式：管理员终端运行，或双击 `unattended\run_unattended.bat`（参数 `live` / `limit-sim`，首次会弹一次 UAC；支持 `--here` 用当前目录为项目、watchdog 崩溃自动重启）。

## 流程（状态机）

```
ENSURE_RUNNING → SEND(同一会话线程, 不点 New Agent) → WAIT_REPLY
   ↑                                                  │ done → TODO.md 打 [x] + git commit
   └── relaunch / switch ────────────────────────────┤ limit/logout/超时
```
- **目标驱动**：`config.json → final_goal_file`（默认 `FinalGoal.md`）。TODO.md 缺失（首次/被删）→ 读 FinalGoal 生成初始规划；队列空 → 先轻量 auto_extend（当前状态），轻量无新任务才对照 FinalGoal 重规划；两层都无新任务 → 目标完成，停止。
- **limit 检测**：DOM 弹窗/横幅关键词（英文+中文），见 `config.json → detection`。
- **完成检测（对话完整性）**：最后消息稳定 `completion_stable_polls` 轮 + pairCount 不变 + 工具卡片数不变 + 无 stop/进行时信号（含 "Waiting xxx for shell"、`N Queued > 0`）+ composer 为空 + done 后确认一轮静默；`_ensure_idle_before_send` 在发送前再兜底拦截（不空闲最多等 30 分钟）。保证**队列最多 1 个**，不堆积 prompt。
- **换号**：杀 Cursor → 点换号助手"刷新Cursor"→ 确认弹窗 → 轮询 `state.vscdb` 的 token 指纹变化 → 重启 Cursor → 用完自动关闭换号助手。
- **预算**：`max_total_account_switches_per_run` 限制总换号次数；超预算的任务记录 SKIP。

## 文件

| 文件 | 作用 |
|---|---|
| `run_here.bat` | **主入口**：复制到项目根双击 = 启动/附加 Cursor + 目标驱动规划 + 无人值守循环（watchdog/禁睡眠） |
| `run_unattended.bat` | 从 unattended 目录运行的启动器（`--here`/`--project`、watchdog） |
| `run_limit_sim.bat` | limit-sim 快捷包装 |
| `config.json` | 运行时配置（项目、FinalGoal、换号助手、检测关键词、超时、retry/auto_extend） |
| `loop.py` | 状态机 + CLI + 两级规划（初始/轻量/FinalGoal）+ git commit |
| `detection.py` | limit / 完成（对话完整性）/ logout 检测 |
| `cursor_ctl.py` | 包装 verify_cdp.py / resume_after_auth.py，控制真实 Cursor |
| `login_assistant.py` | 换号助手 GUI 自动化（pyautogui 模板匹配 + pywinauto 兜底） |
| `todo_queue.py` | TODO.md 解析、生成 prompt（含 git commit 指令）、完成回写 `[x]` |
| `run_state.py` | `runstate/snapshot.json`（断点续跑）+ `events.jsonl`（日志） |

## 注意

- **弹窗自动关闭**：发送前会自动关掉 Cursor 的弹窗（"Update recommended / A newer version of
  Cursor is available"、"Cursor is now on iOS" 等），点的是「Close / Later / Got it / 跳过 / X」，
  会**跳过 Update/Upgrade/Restart/订阅**按钮。只处理可见 modal（`role=dialog` / `.modal` /
  `.cursor-modal-container` 等）；没有弹窗时什么都不点。若遇到新的弹窗没被关掉，把
  `runstate/events.jsonl` 发给我，我来补按钮文案。
- **管理员**：Cursor 与换号助手都要求提升，live/limit-sim 必须以管理员运行，否则换号会报
  `WinError 740 需要提升`。
- **主屏**：`locateOnScreen` 只截主屏；换号助手窗口会被自动移到主屏再点击。
- **TODO.md**：只处理 `- [ ]` / `- [x]`（支持 `[X]`/`[-]`、缩进、CRLF）；完成后原地打 `[x]`。
- **断点续跑**：Ctrl-C 会保存快照，再次运行从上次位置继续。
