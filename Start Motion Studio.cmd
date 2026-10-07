@echo off
rem Motion Studio: double-click this file to start the editor. It opens in your browser. Keep this window open while
rem you work, and close it to stop Motion Studio. The first start (and the first one after an update) installs what
rem the app needs, which takes a few minutes.
title Motion Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node scripts\needs-install.mjs
if errorlevel 1 goto install
goto start

:install
echo Installing Motion Studio. The first time, this downloads about 200 MB and takes a few minutes.
echo.
call npm.cmd install --no-audit --no-fund
if errorlevel 1 goto failed

:start
call npm.cmd start
echo.
echo Motion Studio has stopped. You can close this window.
pause
exit /b 0

:nonode
echo Node.js is not installed, or this window cannot find it.
echo Install it - see "Install" in README.md - then double-click Start Motion Studio again.
echo If you have just installed it, sign out of Windows and back in first.
pause
exit /b 1

:failed
echo.
echo The install did not finish. Read the messages above, fix the problem, then double-click Start Motion Studio again.
pause
exit /b 1
