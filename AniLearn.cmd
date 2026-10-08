@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and try again.
  pause
  exit /b 1
)
node scripts\launcher\bootstrap.cjs %*
if errorlevel 1 pause
