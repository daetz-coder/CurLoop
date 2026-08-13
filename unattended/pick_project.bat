@echo off
rem ============================================================
rem  pick_project.bat - 项目选择器：从列表选项目后一键无人值守
rem
rem  配置：编辑同目录 projects.txt（每行一个项目根目录，# 开头注释）
rem  用法：双击本文件 → 输入编号 → UAC 点"是"
rem ============================================================
setlocal EnableDelayedExpansion
set "PORT=9333"
set "CURSOR_EXE=C:\Program Files\cursor\Cursor.exe"
set "PROJECTS_FILE=%~dp0projects.txt"
set "HARNESS=%~dp0.."

rem ---- 读取项目列表（提权重入时也要用，故无条件读取） ----
if not exist "%PROJECTS_FILE%" (
  echo [fail] 找不到 %PROJECTS_FILE%，请先编辑它（每行一个项目根目录）
  pause
  exit /b 1
)
set /a COUNT=0
for /f "usebackq eol=# tokens=*" %%L in ("%PROJECTS_FILE%") do (
  if not "%%L"=="" (
    set /a COUNT+=1
    set "PROJ_!COUNT!=%%L"
  )
)
if %COUNT%==0 (
  echo [fail] %PROJECTS_FILE% 中没有项目，请先编辑
  pause
  exit /b 1
)

rem ---- 首次运行：显示菜单选择；提权重入（%%1=编号）直接使用 ----
if "%~1"=="" (
  echo ============================================
  echo  选择要运行的项目：
  echo ============================================
  for /l %%i in (1,1,%COUNT%) do (
    echo   [%%i] !PROJ_%%i!
  )
  echo.
  set "CHOICE="
  set /p "CHOICE=输入编号（回车=1）："
  if "!CHOICE!"=="" set "CHOICE=1"
) else (
  set "CHOICE=%~1"
)
set "PROJECT=!PROJ_%CHOICE%!"
if "%PROJECT%"=="" (
  echo [fail] 无效编号：%CHOICE%
  pause
  exit /b 1
)
echo [..] 已选择项目：%PROJECT%

rem ---- 提权（与 loop.py 的 IsUserAnAdmin 同源） ----
powershell -NoProfile -Command "exit ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
if errorlevel 1 goto :admin
echo [..] 请求管理员权限，请在弹出的 UAC 提示中点"是"...
powershell -NoProfile -Command "Start-Process -FilePath \"%~f0\" -ArgumentList '%CHOICE%' -Verb RunAs"
exit /b

:admin
echo [ok] 已以管理员运行，项目=%PROJECT%

rem ---- 启动/附加 Cursor（CDP 9333） ----
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', %PORT%); exit 0 } catch { exit 1 }"
if errorlevel 1 goto :startcursor
goto :ready
:startcursor
echo [..] 启动 Cursor（调试端口 %PORT%）...
python -c "import subprocess,sys; subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x208)" "%CURSOR_EXE%" --remote-debugging-port=%PORT% --user-data-dir="%APPDATA%\Cursor" "%PROJECT%"
echo [..] 等待调试端口就绪（最多 60 秒）...
set /a WAIT=0
:waitport
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', %PORT%); exit 0 } catch { exit 1 }"
if not errorlevel 1 goto :ready
set /a WAIT+=1
if !WAIT! GEQ 20 (
  echo [!] 端口 %PORT% 未就绪（已等待 60 秒）
  goto :end
)
powershell -NoProfile -Command "Start-Sleep -Seconds 3"
goto :waitport
:ready
echo [ok] Cursor 就绪
（%PORT%）。

rem ---- 无人值守循环（实时日志 + watchdog） ----
cd /d "%HARNESS%"
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
set /a CRASHES=0
:loop
python -m unattended.loop --mode live --project "%PROJECT%"
set "RC=!errorlevel!"
if "!RC!"=="0" goto :end
if "!RC!"=="2" goto :end
if "!RC!"=="130" goto :end
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
