@echo off
:: =============================================================================
:: Vocalis "Create a voice" toolchain installer -- VoxCPM2  (Windows)
:: =============================================================================
:: MIRRORS scripts/voxcpm/setup_voxcpm.sh STEP FOR STEP. If you change one, change the
:: other -- nothing in the test suite will fail if you don't.
::
:: Builds the ISOLATED venv for VoxCPM2, the voice-DESIGN model behind the 4.8
:: Create-a-voice flow. Vocalis talks to it only through scripts/voxcpm/worker.py
:: as a child process -- never in-process.
::
:: The worker runs as a child process, keeping VoxCPM2 dependencies and GPU memory outside the
:: main Vocalis runtime.
::
:: WHY FROM THE GITHUB REPO, NOT PyPI:
::   PyPI `voxcpm==1.0.2` is STALE -- its loader only knows the v1 model and demands
::   pytorch_model.bin, which the VoxCPM2 snapshot doesn't ship (model.safetensors).
::   Repo HEAD is voxcpm 2.0.0 and dispatches to VoxCPM2Model.from_local. Built
::   --no-build-isolation (it needs setuptools_scm, and a shallow clone needs the
::   version told to it via SETUPTOOLS_SCM_PRETEND_VERSION).
::
:: The Windows configuration uses CUDA because the supported Windows GPU path is NVIDIA. Override
:: TORCH_INDEX and TORCH_SPEC when a specific CUDA build is required. No CPU mode is provided.
::
:: Standalone use:
::     scripts\voxcpm\setup_voxcpm.bat
::
:: Knobs:
::     VOXCPM_VENV            where it lands       (default: %%USERPROFILE%%\voxcpm-venv)
::     VOCALIS_VOXCPM_PYTHON  a 3.12 interpreter   (default: python; uv fetches 3.12
::                                                  itself when only uv exists)
::     TORCH_INDEX             the wheel index      (default: the CUDA 12.8 index)
::     TORCH_SPEC              the torch packages    (default: "torch torchaudio",
::                                                    unpinned -- override for a pin)
::     VOXCPM_REF              git ref to build      (default: main)
:: =============================================================================
setlocal EnableDelayedExpansion

if "%VOXCPM_VENV%"=="" set "VOXCPM_VENV=%USERPROFILE%\voxcpm-venv"
if "%VOCALIS_VOXCPM_PYTHON%"=="" set "VOCALIS_VOXCPM_PYTHON=python"
if "%TORCH_INDEX%"=="" set "TORCH_INDEX=https://download.pytorch.org/whl/cu128"
if "%TORCH_SPEC%"=="" set "TORCH_SPEC=torch torchaudio"
if "%VOXCPM_REF%"=="" set "VOXCPM_REF=main"
set "VOXCPM_REPO=https://github.com/OpenBMB/VoxCPM"

echo ^>^> Vocalis Create-a-voice toolchain (VoxCPM2)
echo    venv:   %VOXCPM_VENV%
echo    torch:  %TORCH_SPEC%
echo    ref:    %VOXCPM_REF%

if exist "%VOXCPM_VENV%\Scripts\python.exe" (
    echo [1/5] Virtual environment already exists, skipping.
) else (
    echo [1/5] Creating the isolated venv (Python 3.12) ...
    :: The wheels this installs are cp312, so 3.12 is a hard requirement. uv can
    :: materialize a 3.12 even when the system python is newer -- prefer it, exactly
    :: like setup_voxcpm.sh does.
    where uv >nul 2>&1
    if not errorlevel 1 (
        uv venv --python 3.12 "%VOXCPM_VENV%"
        if errorlevel 1 (
            echo ERROR: uv could not create the venv.
            exit /b 1
        )
    ) else (
        "%VOCALIS_VOXCPM_PYTHON%" -c "import sys; sys.exit(0 if sys.version_info[:2]==(3,12) else 1)" >nul 2>&1
        if errorlevel 1 (
            echo ERROR: '%VOCALIS_VOXCPM_PYTHON%' is not Python 3.12, but the pinned wheels are cp312.
            echo        Point VOCALIS_VOXCPM_PYTHON at a 3.12 interpreter, or install uv.
            exit /b 1
        )
        "%VOCALIS_VOXCPM_PYTHON%" -m venv "%VOXCPM_VENV%"
        if errorlevel 1 (
            echo ERROR: could not create the venv.
            exit /b 1
        )
    )
)

set "PY=%VOXCPM_VENV%\Scripts\python.exe"

:: A venv is not guaranteed to have pip (`uv venv` omits it); bootstrap rather than fail
:: obscurely, same as setup_voxcpm.sh.
"%PY%" -m pip --version >nul 2>&1
if errorlevel 1 (
    echo       ^(this venv has no pip - bootstrapping it^)
    "%PY%" -m ensurepip --upgrade >nul
)
"%PY%" -m pip install --upgrade pip --quiet

echo [2/5] Installing torch ...
"%PY%" -m pip install --quiet %TORCH_SPEC% --index-url "%TORCH_INDEX%"
if errorlevel 1 exit /b 1

echo [3/5] Installing the build toolchain (voxcpm builds --no-build-isolation) ...
"%PY%" -m pip install --quiet "setuptools>=77" wheel "setuptools_scm>=8" "packaging>=24.2"
if errorlevel 1 exit /b 1

echo [4/5] Building voxcpm from the repo (%VOXCPM_REF%) ...
:: mktemp -d has no direct Windows equivalent -- a %RANDOM%-suffixed dir under %TEMP% is
:: the usual stand-in. setup_voxcpm.sh removes its clone via a shell `trap ... EXIT`;
:: batch has no trap, so the cleanup below runs at each exit point instead (success AND
:: the failure paths that follow) rather than once, automatically, on any exit.
set "CLONE=%TEMP%\voxcpm_build_%RANDOM%%RANDOM%"
mkdir "%CLONE%" 2>nul
git clone --depth 1 --branch "%VOXCPM_REF%" "%VOXCPM_REPO%" "%CLONE%\VoxCPM" >nul 2>&1
if errorlevel 1 (
    git clone "%VOXCPM_REPO%" "%CLONE%\VoxCPM"
    if errorlevel 1 (
        echo ERROR: could not clone %VOXCPM_REPO%.
        rmdir /s /q "%CLONE%" 2>nul
        exit /b 1
    )
    git -C "%CLONE%\VoxCPM" checkout "%VOXCPM_REF%"
    if errorlevel 1 (
        echo ERROR: could not check out ref %VOXCPM_REF%.
        rmdir /s /q "%CLONE%" 2>nul
        exit /b 1
    )
)
:: A shallow clone has no tags for setuptools_scm to read -- tell it the version.
if "%SETUPTOOLS_SCM_PRETEND_VERSION%"=="" set "SETUPTOOLS_SCM_PRETEND_VERSION=2.0.0"
"%PY%" -m pip install --quiet --no-build-isolation "%CLONE%\VoxCPM"
if errorlevel 1 (
    echo ERROR: voxcpm build failed.
    rmdir /s /q "%CLONE%" 2>nul
    exit /b 1
)
"%PY%" -m pip install --quiet soundfile
if errorlevel 1 (
    rmdir /s /q "%CLONE%" 2>nul
    exit /b 1
)
rmdir /s /q "%CLONE%" 2>nul

echo [5/5] Verifying (imports only -- the ~2 GB model downloads on first load) ...
:: The v1/v2 dispatch check mirrors the .sh's try/except: an AssertionError (or any
:: import failure) exits non-zero with a message on stderr, which is what the
:: errorlevel check below reports.
"%PY%" -c "import importlib.metadata as md; import torch, soundfile, voxcpm; v = md.version('voxcpm'); assert int(v.split('.')[0]) >= 2, f'voxcpm {v} installed -- that is the v1 line; the build did not take'; print(f'   OK: voxcpm {v}, torch {torch.__version__}')"
if errorlevel 1 (
    echo ERROR: the VoxCPM2 toolchain did not come up cleanly.
    exit /b 1
)

echo.
echo ^>^> Done. Vocalis finds this venv at %%USERPROFILE%%\voxcpm-venv (override: voxcpm.venv in
echo    app_settings.yaml, or VOCALIS_VOXCPM_VENV). Weights cache under HF_HOME.
endlocal
