@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo.
    echo  Usage: wav_to_mp3.bat "path\to\folder"
    echo.
    echo  Converts all .wav files in the specified folder to 96 kbps mono MP3.
    echo  MP3s are written to a "mp3" subfolder inside that folder.
    echo  Original WAV files are not modified.
    echo.
    exit /b 1
)

set "INPUT_DIR=%~1"
set "OUTPUT_DIR=%~1\mp3"

if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo.
echo  Input : %INPUT_DIR%
echo  Output: %OUTPUT_DIR%
echo.

set /a COUNT=0
set /a SKIP=0

for %%f in ("%INPUT_DIR%\*.wav") do (
    set "OUT=%OUTPUT_DIR%\%%~nf.mp3"
    if exist "!OUT!" (
        echo  [skip] %%~nxf  ^(already exists^)
        set /a SKIP+=1
    ) else (
        echo  [conv] %%~nxf
        ffmpeg -y -i "%%f" -ac 1 -b:a 96k "!OUT!" -loglevel warning
        set /a COUNT+=1
    )
)

echo.
echo  Converted : !COUNT! file(s)
echo  Skipped   : !SKIP! file(s)  (MP3 already existed)
echo.
