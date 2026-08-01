@echo off
setlocal
cd /d "%~dp0.."

echo Starting OWM local HTTP server...
start "OWM HTTP Server" cmd /k "node src\server\http-server.js"

timeout /t 2 /nobreak >nul

echo Opening sample app...
start "" "%~dp0index.html"
