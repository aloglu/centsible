:: This runs the server in background on Windows.
:: It allows you to get rid of your Terminal window while the server is running.

@echo off
echo Checking for PM2...
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo PM2 not found. Installing globally...
    call npm install -g pm2
) else (
    echo PM2 is already installed.
)
echo.
echo Starting Price Tracker in background...
cd server
call pm2 stop "price-tracker" >nul 2>nul
call pm2 delete "price-tracker" >nul 2>nul
call pm2 start server.js --name "price-tracker" --max-memory-restart 300M
call pm2 save
echo.
echo ===================================================
echo DONE! The price tracker is now running silently.
echo You can close this window.
echo.
echo To stop it later: pm2 stop price-tracker
echo To check status: pm2 list
echo ===================================================
pause
