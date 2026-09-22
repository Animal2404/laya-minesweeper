@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

chcp 936 >nul 2>&1
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set HF_HUB_DISABLE_TELEMETRY=1
set HF_HUB_DISABLE_XET=1
set PORT=8080

echo ============================================================
echo    Laya Minesweeper
echo ============================================================
echo.
echo    代码负责数学约束, Laya 负责判断
echo.
echo    首次运行会下载模型权重, 约 650 MB, 需要几分钟
echo    之后启动约 15-30 秒
echo.
echo ============================================================
echo.

REM 优先用本目录的 .venv
set PY=%~dp0.venv\Scripts\python.exe
if not exist "%PY%" set PY=python

REM 检查 python 可用
"%PY%" -c "import sys" >nul 2>&1
if errorlevel 1 (
    echo [错误] 找不到可用的 Python
    echo.
    echo    请先安装 Python 3.10 以上版本
    echo    或在本目录创建虚拟环境:
    echo        python -m venv .venv
    echo        .venv\Scripts\pip install laya
    echo.
    pause
    exit /b 2
)

REM 检查 laya
"%PY%" -c "import laya" >nul 2>&1
if errorlevel 1 (
    echo [提示] 未检测到 laya, 正在安装 ...
    echo.
    "%PY%" -m pip install laya
    if errorlevel 1 (
        echo.
        echo [错误] 安装失败, 请手动执行:
        echo        "%PY%" -m pip install laya
        echo.
        pause
        exit /b 2
    )
)

echo    启动中, 浏览器会自动打开 ...
echo.
start "" /min cmd /c "timeout /t 25 >nul & start "" http://127.0.0.1:%PORT%/"

"%PY%" server.py --port %PORT%
set CODE=%ERRORLEVEL%

echo.
echo ============================================================
echo    服务已退出, 退出码 %CODE%
echo ============================================================
pause
endlocal
