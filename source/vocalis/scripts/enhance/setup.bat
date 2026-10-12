@echo off
:: =============================================================================
:: Vocalis neural-enhance toolchain installer  (Windows)
:: =============================================================================
:: MIRRORS scripts/enhance/setup.sh EXACTLY. If you change one, change the other --
:: nothing in the test suite will fail if you don't.
::
:: THIS IS NOT OPTIONAL. Chatterbox synthesizes at 24 kHz, so its output is digital
:: silence above ~11 kHz. A 40 kHz RVC model trained on that is asked to reproduce a
:: band that does not exist, which hands its discriminator a free tell ("any energy up
:: there = fake") and training can become unstable. Vocalis refuses to train on band-limited
:: audio; enhancement adds the missing high-frequency content.
::
:: WHY A SEPARATE VENV: resemble-enhance pins torch==2.1.1, Vocalis runs 2.13. They
:: cannot share an environment -- but they are installed together, by the same setup.
:: =============================================================================
setlocal

if "%ENHANCE_VENV%"=="" set "ENHANCE_VENV=%USERPROFILE%\enhance-venv"
if "%VOCALIS_PYTHON%"=="" set "VOCALIS_PYTHON=python"
if "%TORCH_INDEX%"=="" set "TORCH_INDEX=https://download.pytorch.org/whl/cu124"
if "%TORCH_SPEC%"=="" set "TORCH_SPEC=torch==2.6.0+cu124 torchaudio==2.6.0+cu124"

echo ^>^> Vocalis neural-enhance toolchain
echo    venv:  %ENHANCE_VENV%
echo    index: %TORCH_INDEX%

if exist "%ENHANCE_VENV%\Scripts\python.exe" (
    echo [1/4] Virtual environment already exists, skipping.
) else (
    echo [1/4] Creating the isolated venv ...
    "%VOCALIS_PYTHON%" -m venv "%ENHANCE_VENV%"
    if errorlevel 1 (
        echo ERROR: could not create the venv. Install Python 3.10+ or set VOCALIS_PYTHON.
        exit /b 1
    )
)

set "PY=%ENHANCE_VENV%\Scripts\python.exe"

:: A venv is not guaranteed to have pip -- `uv venv` omits it entirely, and re-running
:: this over one of those skips creation (it exists!) then dies on `-m pip` with a bare
:: "No module named pip". Bootstrap it instead.
"%PY%" -m pip --version >nul 2>&1
if errorlevel 1 (
    echo       ^(this venv has no pip - bootstrapping it^)
    "%PY%" -m ensurepip --upgrade >nul
)
"%PY%" -m pip install --upgrade pip --quiet

echo [2/4] Installing torch (must come BEFORE resemble-enhance) ...
"%PY%" -m pip install --quiet %TORCH_SPEC% --index-url "%TORCH_INDEX%"
if errorlevel 1 exit /b 1

echo [3/4] Installing resemble-enhance ...
:: --no-deps IS LOAD-BEARING: resemble-enhance pins torch==2.1.1 and would otherwise
:: downgrade the wheel we just installed to a CPU-only one, silently, ~40x slower.
"%PY%" -m pip install --quiet --no-deps resemble-enhance
if errorlevel 1 exit /b 1

echo [4/4] Installing its real dependencies ...
:: The list lives in requirements.txt, which setup.sh reads TOO -- ONE list, so there is
:: nothing here to drift out of sync with Linux. See that file's header for what is
:: deliberately absent from it (torch, deepspeed, a numpy<2 pin) and why.
"%PY%" -m pip install --quiet -r "%~dp0requirements.txt"
if errorlevel 1 exit /b 1

echo.
echo ^>^> Verifying (this is what catches a CPU-only torch) ...
"%PY%" "%~dp0verify_install.py"
if errorlevel 1 exit /b 1

echo.
echo ^>^> Done. Model weights (~200 MB) download from HuggingFace on first use.
endlocal
