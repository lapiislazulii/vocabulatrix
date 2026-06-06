@echo off
REM Double-click to launch the Random Word app.
REM Opens the browser, then starts the no-cache dev server.
REM Close this window (or press Ctrl+C) to stop the server.
cd /d "%~dp0"
start "" http://localhost:8765/
python serve.py
