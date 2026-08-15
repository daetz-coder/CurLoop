@echo off
rem curloop - CursorHarness CLI：持续 Cursor 对话循环 + 自动换号（TypeScript 版）
rem 在任意目录运行，当前目录即目标项目：curloop run / status / stats / plan / watch / init
node "%~dp0bin\curloop.js" %*