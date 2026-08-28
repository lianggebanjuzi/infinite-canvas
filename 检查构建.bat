@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo  Infinite Canvas 构建检查
echo ==========================================

where npm >nul 2>nul
if %errorlevel%==0 (
  set NPM=npm
) else (
  if exist "C:\Program Files\nodejs\npm.cmd" (
    set NPM=C:\Program Files\nodejs\npm.cmd
  ) else (
    echo [错误] 没有找到 npm，请确认已安装 Node.js。
    pause
    exit /b 1
  )
)

echo [1/2] 正在做 TypeScript 类型检查 ...
call "%NPM%" run typecheck
if %errorlevel% neq 0 (
  echo [失败] 类型检查没通过，请把上面的红字发给 AI。
  pause
  exit /b 1
)

echo [2/2] 正在构建前端 ...
call "%NPM%" run build
if %errorlevel% neq 0 (
  echo [失败] 构建没通过，请把上面的红字发给 AI。
  pause
  exit /b 1
)

echo ==========================================
echo  全部通过：类型检查 OK，前端构建 OK
echo ==========================================
pause
