@echo off
rem Unattended Cursor loop launcher (self-elevates once; UAC prompt on first start).
rem Usage: run_unattended.bat [live|limit-sim] [--here] [--project <dir>]
rem   --here            用"当前所在目录"作为目标项目：先 cd 到项目，再运行本脚本
rem   --project <dir>   指定目标项目（覆盖 config.json 的 project_dir）
rem   watchdog：进程异常退出后自动重启（最多 5 次）；run_done / abort / Ctrl-C 不重启
rem   管理员模式下会临时禁止系统睡眠（无人值守几小时不间断必需）
setlocal EnableDelayedExpansion
set MODE=%1
if "%MODE%"=="" set MODE=live
set "PROJECT_ARG="
if /i "%2"=="--here" (
  set "HERE_DIR=%CD%"
  if "!HERE_DIR:~-1!"=="\" set "HERE_DIR=!HERE_DIR:~0,-1!"
  set "PROJECT_ARG=--project "!HERE_DIR!""
)
rem 本脚本必须从 Harness 的 unattended 目录运行（%~dp0.. = Harness 根）
if not exist "%~dp0__init__.py" (
  echo [fail] 未找到 Harness 模块（unattended 包）。
  echo        请从 D:\2026AppDev\CursorHarness\unattended\run_unattended.bat 原位置运行，
  echo        不要复制到其他目录；或改用 run_here.bat / run_limit_sim.bat。
  pause
  exit /b 1
)
cd /d "%~dp0.."
rem 管理员判定与 loop.py 的 IsUserAnAdmin 同源
powershell -NoProfile -Command "exit ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
if errorlevel 1 goto :admin
echo [..] 请求管理员权限，请在弹出的 UAC 提示中点"是"...
powershell -NoProfile -Command "Start-Process -FilePath \"%~f0\" -ArgumentList '%MODE% %2 %3 %4 %5' -Verb RunAs"
exit /b
:admin
echo [ok] 已以管理员运行，mode=%MODE% %PROJECT_ARG%
rem 无人值守期间禁止睡眠（恢复：powercfg /change standby-timeout-ac 恢复原分钟数）
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
set /a CRASHES=0
:loop
rem 实时显示在控制台（不重定向）；watchdog 用退出码判断：
rem   0=run_done 2=abort/配置错误 130=Ctrl-C  → 不重启；其他(1=崩溃) → 重启
python -m unattended.loop --mode %MODE% %PROJECT_ARG% %3 %4 %5
set "RC=!errorlevel!"
if "!RC!"=="0" goto :done
if "!RC!"=="2" goto :done
if "!RC!"=="130" goto :done
set /a CRASHES+=1
if !CRASHES! GEQ 5 (
  echo [fail] 连续异常退出 5 次，停止自动重启。请查看 unattended\runstate\events.jsonl
  goto :done
)
echo [..] 进程异常退出（exit=!RC!），10 秒后自动重启（第 !CRASHES!/5 次）...
timeout /t 10 /nobreak >nul
goto :loop
:done
pause
