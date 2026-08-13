@echo off
rem CursorHarness 观察面板：双击启动后浏览器打开 http://127.0.0.1:8765
rem dashboard.py 在仓库根目录（%~dp0..），故 cd 到上级
cd /d "%~dp0.."
python dashboard.py 8765
pause
