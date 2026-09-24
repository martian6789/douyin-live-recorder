@echo off
chcp 65001 >nul
title LiveReview 运行环境自检
echo.
echo =================  LiveReview 运行环境自检  =================
echo.
echo 目的：确认本工具是「从固定目录运行」（正常）还是「从系统临时目录运行」（异常）
echo      后者会被游戏反作弊判为高危环境，三角洲行动会报 1067105。
echo.

set "TMPDIR=%TEMP%"
echo 系统临时目录：%TMPDIR%
echo.

echo ---- 正在运行的 LiveReview 进程 ----
set FOUND=0
for /f "usebackq tokens=*" %%P in (`powershell -NoProfile -Command "Get-Process -EA SilentlyContinue ^| Where-Object { $_.ProcessName -match 'LiveReview' } ^| ForEach-Object { try { $_.Path } catch { '' } }"`) do (
  set FOUND=1
  call :CHECK "%%P"
)
if "%FOUND%"=="0" echo   （没有在运行的 LiveReview 进程）

echo.
echo ---- 游戏 / 反作弊进程 ----
powershell -NoProfile -Command "Get-Process -EA SilentlyContinue | Where-Object { $_.ProcessName -match 'SGuard|ACE-|AntiCheatExpert|TenSafe|DeltaForce|delta_force' } | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique"
echo.
echo ============================================================
echo.
echo 判定：
echo   若上面出现「[异常]」，说明你运行的是便携版单文件 exe
echo   —— 请改用绿色版：E:\AI\live-review\app\LiveReview.exe
echo.
pause
exit /b 0

:CHECK
set "P=%~1"
echo   %P%
echo %P% | findstr /I /C:"%TMPDIR%" >nul
if not errorlevel 1 (
  echo     ^>^> [异常] 该进程运行在系统临时目录，会被反作弊判为高危环境
) else (
  echo     ^>^> [正常] 运行在固定目录
)
exit /b 0
