@echo off
rem Set the Vocalis admin username + password. Thin launcher — the logic lives in
rem set-admin-credentials.py (which writes only the scrypt password HASH to
rem admin_credentials.yaml). On Windows this just writes the file; restart your local
rem Vocalis instance for it to take effect. On Linux, use the .sh wrapper,
rem which also restarts the service.)
rem
rem   set-admin-credentials.bat
rem
setlocal
set "HERE=%~dp0"
set "ROOT=%~dp0.."
set "PY=%ROOT%\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" "%HERE%set-admin-credentials.py" %*
if errorlevel 1 exit /b %errorlevel%

echo.
echo Credentials written to admin_credentials.yaml.
echo Restart Vocalis for the change to take effect.
endlocal
