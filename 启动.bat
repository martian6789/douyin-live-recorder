@echo off
set "ELECTRON_RUN_AS_NODE="
if not exist "%~dp0out\main\index.js" (
  echo Build output not found. Run: npm run build
  pause
  exit /b 1
)
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
