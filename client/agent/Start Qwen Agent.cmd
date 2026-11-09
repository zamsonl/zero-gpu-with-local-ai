@echo off
cd /d "%~dp0"
call "Start Qwen OpenCode.cmd" %*
if errorlevel 1 pause
