@echo off
chcp 65001 >nul
title Infinite Canvas push
cd /d "%~dp0"

set "MSG=%~1"
if "%MSG%"=="" set "MSG=chore: daily work commit"

echo.
echo ====== Infinite Canvas push ======
echo [1/3] stage changes...
git add -A
git reset -q -- final2.txt

echo [2/3] commit...
git commit -m "%MSG%" >nul 2>&1
if %errorlevel% neq 0 (
  echo       no new changes, push existing commits
)

echo [3/3] push to GitHub (direct, no proxy)...
git -c http.proxy= -c https.proxy= push origin main
if %errorlevel% equ 0 (
  echo.
  echo ====== push OK ======
) else (
  echo.
  echo ====== push FAILED ======
  echo check the error above, fix FlClash / network, then rerun
)
echo.
