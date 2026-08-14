# curloop

无人值守 Cursor 编码循环（Windows）：CDP 驱动**真实 Cursor**，检测用量限制/登录失效后自动换号（换号助手 GUI 自动化）、重启并续接原会话，按目标项目的 `TODO.md` 复选框队列无人值守执行。

> ⚠️ 自动换号绕过用量限制违反 Cursor ToS，账号存在风控/封禁风险。默认 `dry-run`，真实换号需显式 `--mode live` 且以管理员运行。

## 安装

要求：Windows + Node.js ≥ 18。首次安装会自动下载嵌入式 Python 3.12（约 21MB）并安装 Python 依赖，无需预装 Python。

```bash
npm install -g curloop
```

国内网络下载 Python 慢时，可先设置镜像源再安装：

```powershell
# Windows PowerShell
$env:CURSOR_HARNESS_PYTHON_URL = "https://<你的镜像>/cpython-3.12.13%2B20260807-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
npm install -g curloop
```

## 快速开始

```bash
curloop --check-config            # 配置自检（只读）
curloop status                    # 查看目标项目状态（当前目录 = 目标项目）
curloop run --mode live           # 无人值守运行（需管理员）
curloop run --mode live --project D:\path\to\project
```

用法分两种，自动识别：

- **无人值守直通**：第一个参数以 `-` 开头（`--check-config` / `--dry-run` / `--detect-only` / `--mode ...`）
- **交互 CLI**：无参数进入 REPL，或子命令 `run` / `plan` / `status` / `stats` / `watch` / `init`

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
3. 撞限/掉线时自动换号：pyautogui 模板匹配点击换号助手「刷新Cursor → 确认」→ 等 token 翻转 → 重启续跑
4. 每个任务完成后自动 `git commit`，队列动态吸收 Agent 追加的新任务

## 依赖

- 嵌入式 Python 3.12.13（python-build-standalone），`npm install` 时下载到 `runtime\python\`
- Python 依赖：`websockets` / `pyautogui` / `prompt_toolkit`（自动 pip 安装）
- 可选：`pywinauto` / `comtypes` / `wmi`（UIA 兜底，未安装时自动降级为纯模板匹配）

## 从源码开发

```bash
git clone git@github.com:daetz-coder/CurLoop.git
cd CurLoop
npm install && npm link     # 本地 curloop 命令指向本目录
```

## License

UNLICENSED（私有项目，未经授权禁止分发）。
