@echo off
rem Double-click to build and launch DualSense Haptic Designer.
title DualSense Haptic Designer
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 goto :fail
)

rem Some environments set this, which makes Electron start as plain Node.
set ELECTRON_RUN_AS_NODE=

echo Building and starting... (you can minimise this window; closing it closes the app)
call npm start
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo Something went wrong - see the messages above.
pause
exit /b 1
