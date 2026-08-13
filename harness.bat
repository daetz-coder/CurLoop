@echo off
rem CursorHarness CLI：在任何目录运行，当前目录即目标项目
rem 用法：harness.bat run|plan|status|stats|watch|init [选项]
python "%~dp0harness.py" %*
pause
