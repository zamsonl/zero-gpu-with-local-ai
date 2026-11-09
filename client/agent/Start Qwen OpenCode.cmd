@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is needed. Opening the official installer page.
  echo Install the LTS version with npm, then double-click this launcher again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Your Node.js is too old. Opening the official installer page.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
if "%~1"=="" (
  start "" wscript.exe //nologo "%~dp0Start Qwen Setup.vbs"
  exit /b 0
) else (
  node "%~dp0opencode.mjs" %*
)
if errorlevel 1 (
  echo.
  echo Setup stopped. No automatic retry is made if a Kaggle launch was uncertain.
  echo Double-click again for guided setup, or use --help for advanced options.
  pause
  exit /b 1
)
