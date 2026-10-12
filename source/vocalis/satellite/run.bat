@echo off
:: Vocalis render satellite - foreground launcher.
::
:: Run in a console so logs remain visible and closing the window stops the server.
setlocal
set "HERE=%~dp0"
set "PYTHON=%HERE%venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo ERROR: no venv here. Run setup.bat first.
    pause & exit /b 1
)

echo Starting the Vocalis render satellite. Close this window to stop it.
echo.
"%PYTHON%" "%HERE%server.py" %*
echo.
echo Satellite stopped.
pause
