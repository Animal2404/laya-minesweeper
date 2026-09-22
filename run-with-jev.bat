@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

chcp 936 >nul 2>&1
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set HF_HUB_DISABLE_TELEMETRY=1
set HF_HUB_DISABLE_XET=1
set PORT=8080

REM ============================================================
REM  Jev launcher
REM  Starts the minesweeper server with the cloud Jev model
REM  enabled, so you can switch between Laya (local) and Jev
REM  (cloud) from the "model" dropdown on the page.
REM ============================================================

REM ---- Jev API settings (edit here if the key changes) ----
set JEV_API_KEY=vb-PjHIHcciEr8UwY-OYqsbW54int7L3AXzEn28czlfmNc
set JEV_BASE_URL=https://omnilabs.vibeadmin.cn/v1
set JEV_MODEL=jev-latest

echo ============================================================
echo    Laya Minesweeper  +  Jev (cloud)
echo ============================================================
echo.
echo    Local model : Laya  (GPU, ~0.1s per call)
echo    Cloud model : Jev   (internet, ~10s per call)
echo.
echo    Switch between them with the [model] dropdown
echo    at the top of the page.
echo.
echo    First run downloads model weights (~650 MB).
echo    Startup takes about 15-30 seconds.
echo.
echo ============================================================
echo.

REM ---- locate a python that has laya installed ----
REM  Order: this repo .venv, then the two known local venvs, then PATH.
set PY=
if exist "%~dp0.venv\Scripts\python.exe" set PY=%~dp0.venv\Scripts\python.exe
if not defined PY if exist "E:\DeepSeek\laya-local\.venv\Scripts\python.exe" set PY=E:\DeepSeek\laya-local\.venv\Scripts\python.exe
if not defined PY if exist "E:\DeepSeek\laya-playground\.venv\Scripts\python.exe" set PY=E:\DeepSeek\laya-playground\.venv\Scripts\python.exe
if not defined PY set PY=python
echo    Python : %PY%
echo.

REM ---- sanity check python ----
"%PY%" -c "import sys" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found.
    echo.
    echo    Install Python 3.10+ and run:
    echo        python -m venv .venv
    echo        .venv\Scripts\pip install laya
    echo.
    pause
    exit /b 2
)

REM ---- sanity check laya ----
"%PY%" -c "import laya" >nul 2>&1
if errorlevel 1 (
    echo [INFO] laya not found in this python, installing ...
    echo.
    "%PY%" -m pip install laya
    if errorlevel 1 (
        echo.
        echo [ERROR] install failed, run manually:
        echo        "%PY%" -m pip install laya
        echo.
        pause
        exit /b 2
    )
)

REM ---- quick reachability check for the Jev endpoint ----
echo    Checking Jev endpoint ...
set JEVCHK=import os,ssl,json,urllib.request;c=ssl.create_default_context();c.check_hostname=False;c.verify_mode=ssl.CERT_NONE;r=urllib.request.Request(os.environ["JEV_BASE_URL"]+"/models",headers={"Authorization":"Bearer "+os.environ["JEV_API_KEY"]});d=json.loads(urllib.request.urlopen(r,timeout=20,context=c).read());print("    Jev OK -",len(d.get("data",[])),"models")
"%PY%" -c "%JEVCHK%" 2>nul
if errorlevel 1 (
    echo    [WARN] Jev endpoint unreachable right now.
    echo           The page still starts; Jev shows as unavailable
    echo           and the page falls back to Laya automatically.
    echo           This is usually a temporary network issue.
)
echo.

REM ---- find the local model directory ----
set MODELDIR=
if exist "%~dp0models\laya" set MODELDIR=%~dp0models\laya
if not defined MODELDIR if exist "E:\DeepSeek\laya-local\models\laya" set MODELDIR=E:\DeepSeek\laya-local\models\laya

echo    Starting server on port %PORT% ...
echo.
start "" /min cmd /c "timeout /t 22 >nul & start "" http://127.0.0.1:%PORT%/"

if defined MODELDIR (
    echo    Model dir: %MODELDIR%
    "%PY%" server.py --port %PORT% --model "%MODELDIR%" --subfolder typed-decisions
) else (
    echo    Model dir: (downloading from HuggingFace)
    "%PY%" server.py --port %PORT% --model "convaiinnovations/laya" --subfolder typed-decisions
)
set CODE=%ERRORLEVEL%

echo.
echo ============================================================
echo    Server stopped, exit code %CODE%
echo ============================================================
pause
endlocal
