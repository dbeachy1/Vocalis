@echo off
cd /d "%~dp0.."
"venv\Scripts\python.exe" src\book_to_audio.py %*
