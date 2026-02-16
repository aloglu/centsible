@echo off
REM This script starts Centsible in Windows background mode using PM2.
REM Use it when you want the tracker to keep running after closing this terminal window.
REM Intended for running Centsible on a Windows machine (not a dedicated server).
REM Use PM2 so the tracker keeps running after this terminal closes.
echo Checking for PM2...
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo PM2 not found. Installing globally...
    call npm install -g pm2
) else (
    echo PM2 is already installed.
)
echo.
echo Starting Centsible in background...
REM Move to backend and replace any stale process with the same name.
cd server
call pm2 stop "centsible" >nul 2>nul
call pm2 delete "centsible" >nul 2>nul
call pm2 start server.js --name "centsible" --max-memory-restart 300M
REM Persist PM2 process list so it can be restored on reboot if configured.
call pm2 save
echo.
echo ===================================================
echo DONE! Centsible is now running silently.
echo You can close this window.
echo.
echo To stop it later: pm2 stop centsible
echo To check status: pm2 list
echo ===================================================
pause
