@echo off
setlocal EnableDelayedExpansion

echo ================================================
echo  Vocalis Render Satellite - Setup
echo  CUDA 12.4 / RTX 4090
echo ================================================
echo.

set "HERE=%~dp0"
set "CHATTERBOX_WHEEL=%HERE%chatterbox_tts-0.1.7+vocalis.1-py3-none-any.whl"
if not exist "%CHATTERBOX_WHEEL%" set "CHATTERBOX_WHEEL=%HERE%..\..\..\packaging\chatterbox\chatterbox_tts-0.1.7+vocalis.1-py3-none-any.whl"
if not exist "%CHATTERBOX_WHEEL%" (
    echo ERROR: The pinned Vocalis Chatterbox wheel is missing.
    echo Copy packaging\chatterbox\chatterbox_tts-0.1.7+vocalis.1-py3-none-any.whl beside setup.bat.
    exit /b 1
)
set "VENV=%HERE%venv"
set "PYTHON=%VENV%\Scripts\python.exe"

:: Arguments are passed straight through to setup.py, so
::     setup.bat --name satellite01 --san satellite01.example 192.0.2.10
:: provisions under a non-default name and adds SANs to the certificate.

:: Versions pinned so the satellite and server render identically. Torch differs
:: by necessity: the Windows satellite uses CUDA; a ROCm server requires a different Torch build.

:: ------------------------------------------------------------------
:: 1. Virtual environment
:: ------------------------------------------------------------------
if exist "%PYTHON%" (
    echo [1/7] Virtual environment already exists, skipping.
) else (
    echo [1/7] Creating virtual environment in .\venv ...
    python -m venv "%VENV%"
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment.
        echo Make sure 'python' resolves to Python 3.10+ in your PATH.
        pause & exit /b 1
    )
)

:: ------------------------------------------------------------------
:: 2. pip
:: ------------------------------------------------------------------
echo [2/7] Upgrading pip...
"%PYTHON%" -m pip install --upgrade pip --quiet
if errorlevel 1 ( echo ERROR: pip upgrade failed. & pause & exit /b 1 )

:: ------------------------------------------------------------------
:: 3. PyTorch with CUDA 12.4  (~2.5 GB)
:: ------------------------------------------------------------------
echo [3/7] Installing PyTorch 2.6.0 + CUDA 12.4  (^~2.5 GB download^)...
"%PYTHON%" -m pip install ^
    torch==2.6.0+cu124 ^
    torchaudio==2.6.0+cu124 ^
    --index-url https://download.pytorch.org/whl/cu124
if errorlevel 1 (
    echo ERROR: PyTorch CUDA install failed.
    pause & exit /b 1
)

:: ------------------------------------------------------------------
:: 4. chatterbox-tts WITHOUT its deps.
::    --no-deps is REQUIRED: chatterbox's own metadata pulls a plain
::    'torch', and pip will happily replace the CUDA build above with
::    the CPU wheel from PyPI. Step 6 verifies it did not.
:: ------------------------------------------------------------------
echo [4/7] Installing Vocalis Chatterbox TTS wheel (no-deps)...
"%PYTHON%" -m pip install "%CHATTERBOX_WHEEL%" --no-deps
if errorlevel 1 ( echo ERROR: chatterbox-tts install failed. & pause & exit /b 1 )

:: ------------------------------------------------------------------
:: 5. The remaining pinned dependencies.
::    No gradio: the satellite has no UI, it is driven by Vocalis.
::    soundfile >= 0.12 is REQUIRED - the satellite decodes voice
::    samples from memory, and mp3-from-buffer needs libsndfile 1.1+.
::    NOTE: git must be in PATH for resemble-perth.
::    nvidia-ml-py + pywin32 (2.0): the GPU stats Vocalis shows -
::    NVML for clocks/power/temp/fan, and the Windows GPU performance
::    counters for this process's own VRAM (NVML cannot see it on WDDM).
:: ------------------------------------------------------------------
echo [5/7] Installing dependencies (git must be in PATH for resemble-perth)...
"%PYTHON%" -m pip install ^
    "numpy>=2.0.0" ^
    "librosa==0.11.0" ^
    "soundfile>=0.12" ^
    "s3tokenizer==0.3.0" ^
    "transformers==5.2.0" ^
    "diffusers==0.29.0" ^
    "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@master" ^
    "conformer==0.3.2" ^
    "safetensors==0.5.3" ^
    "spacy-pkuseg" ^
    "pyloudnorm" ^
    "omegaconf" ^
    "flask" ^
    "loguru" ^
    "keyring" ^
    "cryptography" ^
    "nvidia-ml-py" ^
    "pywin32"
if errorlevel 1 (
    echo ERROR: Dependency install failed.
    echo If the error mentions 'resemble-perth', ensure git.exe is in your PATH.
    pause & exit /b 1
)

:: ------------------------------------------------------------------
:: 6. Verify CUDA torch survived step 4/5, then prove the stack works.
:: ------------------------------------------------------------------
echo.
echo [6/7] Verifying CUDA torch is still active...
"%PYTHON%" -c "import torch; v=torch.__version__; assert 'cu' in v, f'CPU torch detected: {v}'; print(f'  torch {v}  --  OK'); assert torch.cuda.is_available(), 'CUDA not available'; print(f'  {torch.cuda.get_device_name(0)}  --  OK')"
if errorlevel 1 (
    echo.
    echo ERROR: CUDA torch was overwritten, or no CUDA device is visible.
    echo Re-run step 3:
    echo   venv\Scripts\pip install torch==2.6.0+cu124 torchaudio==2.6.0+cu124 --index-url https://download.pytorch.org/whl/cu124
    pause & exit /b 1
)

:: ------------------------------------------------------------------
:: 7. Provisioning: the shared secret and the TLS keypair.
::    Provision the shared secret and TLS keypair before the self-test. The
::    first self-test downloads the model, so perform the quick credential step
::    first and let the download run afterward.
::    Arguments to setup.bat land here; setup.py itself is idempotent and
::    asks before replacing an existing secret or certificate.
:: ------------------------------------------------------------------
echo.
echo [7/7] Provisioning (shared secret + TLS certificate)...
"%PYTHON%" "%HERE%setup.py" %*
if errorlevel 1 (
    echo.
    echo ERROR: Provisioning failed - see above.
    echo You can re-run it alone with:  venv\Scripts\python setup.py
    pause & exit /b 1
)

echo.
echo ================================================
echo  Install complete. Running the self-test...
echo ================================================
echo  (first run downloads the Chatterbox weights from
echo   HuggingFace - about 3 GB - and is slow)
echo.
"%PYTHON%" "%HERE%selftest.py"
if errorlevel 1 (
    echo.
    echo SELF-TEST FAILED - see the error above.
    pause & exit /b 1
)

echo.
echo ================================================
echo  Satellite ready.
echo ================================================
echo   1. Copy certs\cert.pem to Vocalis and pin it on this satellite's entry.
echo   2. Start the satellite:  run.bat
echo   3. In Vocalis, tick this satellite's cards and press Load.
echo.
pause
