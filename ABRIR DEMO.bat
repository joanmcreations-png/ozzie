@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "Demo IA Server" node server.js
  timeout /t 2 /nobreak >nul
  start "" http://localhost:3210
) else (
  start "" index.html
)
