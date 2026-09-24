@echo off
chcp 65001 >nul
title LiveReview C-drive cleanup
echo.
echo  Cleaning LiveReview leftovers on C drive...
echo  (close LiveReview first, otherwise some files stay locked)
echo.

rd /s /q "C:\Users\Administrator\AppData\Roaming\live-review" 2>nul
for /d %%D in ("%TEMP%\electron-download-*") do rd /s /q "%%D" 2>nul
for /d %%D in ("%TEMP%\electron-*") do rd /s /q "%%D" 2>nul

if exist "C:\Users\Administrator\AppData\Roaming\live-review" (
  echo  [LEFT] Roaming\live-review still exists - LiveReview is running.
) else (
  echo  [OK]   Roaming\live-review removed.
)

echo.
echo  Done.
timeout /t 5 >nul
