@echo off
REM Run the Vocalis test suite.
REM
REM Usage:
REM   run_tests.bat              -- fast unit tests only (chunker, docx parsing)
REM   run_tests.bat --gpu        -- also runs GPU integration tests (loads TTS model)
REM   run_tests.bat -k chunker   -- run only tests matching "chunker"

cd /d "%~dp0.."
venv\Scripts\python.exe -m pytest tests\ -v %*
