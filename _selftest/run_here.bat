@echo off
rem ============================================================
rem  run_here.bat - 项目一键无人值守（单文件，复制到项目根即可）
rem
rem  用法：把本文件【复制】到目标项目根目录，双击运行。
rem    1) 自动以调试模式打开 Cursor（CDP 9333）并加载本目录
rem       （若已带端口运行则直接附加，不会重启）
rem    2) 运行无人值守循环：发任务 / 检测并关闭弹窗 / 自动换号
rem  可选参数：run_here.bat [live|limit-sim]   （默认 live）
rem  首次运行会弹一次 UAC（需要管理员）。
rem  若 Harness 装在别处，请修改下面 HARNESS 一行。
rem ============================================================
setlocal EnableDelayedExpansion
set "HARNESS=D:\2026AppDev\CursorHarness"
set "CURSOR_EXE=C:\Program Files\cursor\Cursor.exe"
set "PORT=9333"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=live"
set "PROJECT=%~dp0"
if "%PROJECT:~-1%"=="\" set "PROJECT=%PROJECT:~0,-1%"

rem ---- 防止在 Harness 的 unattended 目录里误运行 ----
if /i "%PROJECT%"=="%HARNESS%\unattended" (
  echo [fail] 请不要在 Harness 的 unattended 目录里运行本文件。
  echo        请把本文件【复制】到目标项目的根目录后再双击。
  pause
  exit /b 1
)

rem ---- 管理员判定（与 loop.py 的 IsUserAnAdmin 同源）----
powershell -NoProfile -Command "exit ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
if errorlevel 1 goto :admin
echo [..] 请求管理员权限，请在弹出的 UAC 提示中点"是"...
powershell -NoProfile -Command "Start-Process -FilePath \"%~f0\" -ArgumentList '%MODE%' -Verb RunAs"
exit /b

:admin
echo [ok] 已以管理员运行，项目=%PROJECT% mode=%MODE%

rem ---- 1) 确保 Cursor 以调试端口运行（已运行则直接附加）----
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', %PORT%); exit 0 } catch { exit 1 }"
if errorlevel 1 goto :startcursor
goto :ready
:startcursor
echo [..] 启动 Cursor（调试端口 %PORT%）：项目=%PROJECT%
rem 用 python 静音启动（与 harness 的 launch_cursor 一致：DEVNULL + DETACHED，杜绝 Cursor 主进程日志污染控制台）
python -c "import subprocess,sys; subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x208)" "%CURSOR_EXE%" --remote-debugging-port=%PORT% --user-data-dir="%APPDATA%\Cursor" "%PROJECT%"
echo [..] 等待调试端口就绪（最多 60 秒）...
set /a WAIT=0
:waitport
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', %PORT%); exit 0 } catch { exit 1 }"
if not errorlevel 1 goto :ready
set /a WAIT+=1
if !WAIT! GEQ 20 (
  echo [!] 端口 %PORT% 未就绪（已等待 60 秒）：若 Cursor 之前已在运行，请先关闭它再试；否则检查 Cursor 是否启动失败。
  goto :end
)
powershell -NoProfile -Command "Start-Sleep -Seconds 3"
goto :waitport
:ready
echo [ok] Cursor 就绪（%PORT%）。请在 Cursor 中打开聊天界面（如尚未打开）。

rem ---- 2) 无人值守循环：发任务 / 弹窗 / 换号 / watchdog ----
cd /d "%HARNESS%"
rem 无人值守期间禁止系统睡眠（恢复：powercfg /change standby-timeout-ac 恢复原分钟数）
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
set /a CRASHES=0
:loop
python -m unattended.loop --mode %MODE% --project "%PROJECT%" > "%TEMP%\cursorharness_here.log" 2>&1
set "RC=!errorlevel!"
type "%TEMP%\cursorharness_here.log"
if "!RC!"=="130" goto :end
rem run() 只有 run_done 返回 0：正常完成绝不重启（不依赖日志内容判断）
if "!RC!"=="0" goto :end
findstr /C:"run_done" "%TEMP%\cursorharness_here.log" >nul && goto :end
findstr /C:"run_abort" "%TEMP%\cursorharness_here.log" >nul && goto :end
set /a CRASHES+=1
if !CRASHES! GEQ 5 (
  echo [fail] 连续异常退出 5 次，停止自动重启。请查看 %HARNESS%\unattended\runstate\events.jsonl
  goto :end
)
echo [..] 进程异常退出（exit=!RC!），10 秒后自动重启（第 !CRASHES!/5 次）...
timeout /t 10 /nobreak >nul
goto :loop
:end
pause
