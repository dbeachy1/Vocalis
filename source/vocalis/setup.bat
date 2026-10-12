@echo off
setlocal EnableDelayedExpansion

echo ================================================
echo  Vocalis Setup  -  RTX 4090 / CUDA 12.4
echo ================================================
echo.

set "VENV=%~dp0venv"
set "PIP=%VENV%\Scripts\pip.exe"
set "PYTHON=%VENV%\Scripts\python.exe"

:: ------------------------------------------------------------------
:: 1. Create virtual environment (uses your system Python 3.13.2)
::    Does NOT touch your system Python or PATH.
:: ------------------------------------------------------------------
if exist "%VENV%\Scripts\python.exe" (
    echo [1/6] Virtual environment already exists, skipping.
) else (
    echo [1/6] Creating virtual environment in .\venv ...
    python -m venv "%VENV%"
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment.
        echo Make sure 'python' resolves to Python 3.10+ in your PATH.
        pause & exit /b 1
    )
)

:: ------------------------------------------------------------------
:: 2. Upgrade pip inside the venv
:: ------------------------------------------------------------------
echo [2/6] Upgrading pip...
"%PYTHON%" -m pip install --upgrade pip --quiet
if errorlevel 1 ( echo ERROR: pip upgrade failed. & pause & exit /b 1 )

:: ------------------------------------------------------------------
:: 3. Install PyTorch 2.6.0 with CUDA 12.4  (RTX 4090)
::    Uses the official PyTorch CUDA wheel index.
::    This is ~2.5 GB - will take a few minutes on first run.
:: ------------------------------------------------------------------
echo [3/6] Installing PyTorch 2.6.0 + CUDA 12.4  (^~2.5 GB download^)...
"%PYTHON%" -m pip install ^
    torch==2.6.0+cu124 ^
    torchaudio==2.6.0+cu124 ^
    --index-url https://download.pytorch.org/whl/cu124
if errorlevel 1 (
    echo ERROR: PyTorch CUDA install failed.
    echo Check your internet connection and try again.
    pause & exit /b 1
)

:: ------------------------------------------------------------------
:: 4. Install chatterbox-tts WITHOUT its own deps.
::    We skip --deps so pip doesn't overwrite our CUDA torch with
::    the CPU-only version from PyPI.
:: ------------------------------------------------------------------
echo [4/6] Installing Chatterbox TTS package (no-deps)...
"%PYTHON%" -m pip install "%HERE%..\..\packaging\chatterbox\chatterbox_tts-0.1.7+vocalis.1-py3-none-any.whl" --no-deps
if errorlevel 1 ( echo ERROR: chatterbox-tts install failed. & pause & exit /b 1 )

:: ------------------------------------------------------------------
:: 5. Install all remaining dependencies manually.
::    Excludes torch/torchaudio (already installed with CUDA above).
::    NOTE: git must be in PATH for the resemble-perth install.
:: ------------------------------------------------------------------
echo [5/6] Installing remaining dependencies...
echo       (resemble-perth clones from GitHub - git must be in PATH)
"%PYTHON%" -m pip install ^
    "numpy>=2.0.0" ^
    "librosa==0.11.0" ^
    "s3tokenizer" ^
    "transformers==5.2.0" ^
    "diffusers==0.29.0" ^
    "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@master" ^
    "conformer==0.3.2" ^
    "safetensors==0.5.3" ^
    "spacy-pkuseg" ^
    "pyloudnorm" ^
    "omegaconf" ^
    "pytest" ^
    "pytest-xdist" ^
    "pytest-timeout" ^
    "python-docx" ^
    "flask" ^
    "flask-cors" ^
    "loguru" ^
    "lxml==6.1.3" ^
    "soundfile" ^
    "ruamel.yaml" ^
    "cryptography>=42" ^
    "argon2-cffi" ^
    "pillow>=10"
if errorlevel 1 (
    echo ERROR: Dependency install failed.
    echo If the error mentions 'resemble-perth', ensure git.exe is in your PATH.
    pause & exit /b 1
)

:: ------------------------------------------------------------------
:: Quick sanity check - verify CUDA torch is still the active install
:: ------------------------------------------------------------------
echo.
echo Verifying CUDA torch is active...
"%PYTHON%" -c "import torch; v=torch.__version__; assert 'cu' in v, f'CPU torch detected: {v}'; print(f'  torch {v}  --  OK')"
if errorlevel 1 (
    echo WARNING: CUDA torch may have been overwritten. Re-run step 3:
    echo   venv\Scripts\pip install torch==2.6.0+cu124 torchaudio==2.6.0+cu124 --index-url https://download.pytorch.org/whl/cu124
)

:: ------------------------------------------------------------------
:: 6. Neural-enhance toolchain  (NOT OPTIONAL)
::    Chatterbox synthesizes at 24 kHz, so its output is digital silence above ~11 kHz.
::    A 40 kHz RVC model trained on that is asked to reproduce a band that does not
::    exist, which hands its discriminator a free tell and can corrupt a training run.
::    Vocalis refuses band-limited training audio, so this toolchain is required.
::
::    It gets its OWN venv: resemble-enhance pins torch==2.1.1 and we run 2.6 -- they
::    cannot share an environment. But they install together, here, from one setup.
:: ------------------------------------------------------------------
echo.
echo [6/6] Installing the neural-enhance toolchain (isolated venv)...
call "%~dp0scripts\enhance\setup.bat"
if errorlevel 1 (
    echo.
    echo ERROR: the neural-enhance toolchain failed to install.
    echo        Voice training will REFUSE to run without it -- see scripts\enhance\setup.bat
    exit /b 1
)

echo.
echo ================================================
echo  Vocalis setup complete!
echo ================================================
echo.
echo  Launcher scripts:
echo    scripts\start_web.bat       Vocalis web app (port 7870)
echo    scripts\generate.bat        CLI generation  (run scripts\generate.bat --help)
echo.
echo  Models are downloaded from HuggingFace on first run (~3-5 GB).
echo  Your system Python and PATH are unchanged.
echo.
:: Setup builds a venv and stops. It configures NOTHING, and the user has no way to know that
:: from here. Mirrors the closing block in setup.sh (encryption is Linux-only, so this half
:: names BitLocker instead).
echo  ------------------------------------------------------------------
echo  NOT CONFIGURED YET. Setup installs; it does not configure.
echo  Still yours to decide: the admin login, the per-instance paths, and
echo  disk encryption. Vocalis's own at-rest encryption is Linux-only, so
echo  on Windows that means BitLocker. Read this before you generate:
echo.
echo    README.md, section 'After setup - what you still have to decide'
echo  ------------------------------------------------------------------
echo.
pause
