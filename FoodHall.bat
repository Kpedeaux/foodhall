@echo off
title Food Hall Launcher
cd /d C:\Users\pedea\CoreRail\FoodHall

:: Verify node is available
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found on PATH.
    echo Run: nvm install 22 && nvm use 22
    pause
    exit /b 1
)

for /f "tokens=*" %%V in ('node -v') do echo Using Node %%V

:: Start Express API server (port 3001)
start "FoodHall-API" cmd /k "cd /d C:\Users\pedea\CoreRail\FoodHall && node server/index.js"

:: Give the API server a moment to bind
timeout /t 3 /nobreak >nul

:: Start Vite dev server (port 3000)
start "FoodHall-Vite" cmd /k "cd /d C:\Users\pedea\CoreRail\FoodHall && npx vite --host"
