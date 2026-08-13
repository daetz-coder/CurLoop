@echo off
rem ============================================================
rem  curloop 一键注册：把本仓库根目录加入【用户 PATH】
rem  运行一次后，重新打开终端即可在任意目录直接使用 curloop
rem ============================================================
setlocal
set "HX_DIR=%~dp0"
echo [..] 注册目录：%HX_DIR%
powershell -NoProfile -Command "$d='%HX_DIR%'.TrimEnd('\'); $p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -contains $d) { Write-Output '[ok] 已在用户 PATH 中' } else { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';')+';'+$d), 'User'); Write-Output '[ok] 已加入用户 PATH' }"
echo.
echo 完成！请【重新打开】终端（新窗口），然后在任意项目目录直接输入：
echo   curloop run        无人值守运行（读 FinalGoal 生成 TODO ^-^> 执行 ^-^> 续接 ^-^> 换号）
echo   curloop status     查看状态 / 统计 / 事件
echo   curloop stats      统计摘要（换号 / 对话 / 完成）
echo   curloop plan       只生成 TODO.md
echo   curloop watch      实时监控
echo   curloop init       生成 FinalGoal.md / TODO.md 模板
echo.
echo 选项：--mode live^|limit-sim^|dry-run   --no-plan（跳过生成 TODO）  --project PATH
pause
