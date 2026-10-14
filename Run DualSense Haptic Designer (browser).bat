@echo off
rem Double-click to build DualSense Haptic Designer for the browser, serve it on
rem http://localhost:5174 and open it in Chrome or Edge.
title DualSense Haptic Designer (browser)
cd /d "%~dp0"
set URL=http://localhost:5174/
if "%~1"==":open" goto :open

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

rem Already running? Just open another tab.
netstat -ano | findstr /r /c:":5174 .*LISTENING" >nul
if not errorlevel 1 (
  call :open
  exit /b 0
)

if not exist "node_modules\" (
  echo First run: installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 goto :fail
)

echo Building...
call npm run web:build
if errorlevel 1 goto :fail

rem Open the browser in the background once the server below is listening.
start "" /b cmd /c ""%~f0" :open"

echo Serving at %URL% - closing this window stops the server.
call npm run web:preview
if errorlevel 1 goto :fail
exit /b 0

:open
rem Wait (up to ~20 s) for the server, then open Chrome, or Edge if Chrome isn't installed.
rem Chrome/Edge only: the controller needs WebHID, which Firefox and Safari lack.
for /l %%i in (1,1,40) do (
  netstat -ano | findstr /r /c:":5174 .*LISTENING" >nul && goto :launch
  ping -n 1 -w 500 192.0.2.1 >nul
)
:launch
set BROWSER=msedge
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>nul && set BROWSER=chrome
reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>nul && set BROWSER=chrome
start "" %BROWSER% "%URL%"
exit /b 0

:fail
echo.
echo Something went wrong - see the messages above.
pause
