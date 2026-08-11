@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1 || (echo [ERROR] Node.js 20+ is required.& exit /b 1)
if not exist config.json (echo [ERROR] Run npm run setup first.& exit /b 1)
node.exe server.mjs
