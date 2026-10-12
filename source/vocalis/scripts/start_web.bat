@echo off
cd /d "%~dp0.."
echo ====================================
echo  Vocalis 2.0 - Book Web UI
echo ====================================
echo.
echo Open http://127.0.0.1:7870 in your browser.
echo Press Ctrl+C to stop the server.
echo.
REM vocalis.py, not src\vocalis_server.py — see 5.1-refactor 2.1: launching the
REM module directly makes it __main__, and any later import of it re-executes the file.
"venv\Scripts\python.exe" vocalis.py %*
pause
