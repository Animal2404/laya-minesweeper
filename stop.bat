@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

chcp 936 >nul 2>&1

set SRV_PORT=8080
set FOUND=0

echo ============================================================
echo    停止 Laya Minesweeper
echo ============================================================
echo.

REM ---- 1) 按默认端口找（最可靠） ----
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%SRV_PORT% .*LISTENING"') do (
    echo    端口 %SRV_PORT% 上的进程 PID %%p, 正在结束 ...
    taskkill /PID %%p /F >nul 2>&1
    set FOUND=1
)

REM ---- 2) 兜底：按命令行特征找（端口被改过时也能停） ----
REM    注意：新版 Windows 已移除 wmic，这里用 PowerShell 查 Win32_Process
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*server.py*' -and $_.CommandLine -like '*laya-minesweeper*' } | Select-Object -ExpandProperty ProcessId" 2^>nul`) do (
    echo    本项目的 python 进程 PID %%p, 正在结束 ...
    taskkill /PID %%p /F >nul 2>&1
    set FOUND=1
)

REM ---- 3) 再兜底：本项目目录下的 server.py（路径里含 laya-minesweeper） ----
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.ExecutablePath -like '*laya-minesweeper*' } | Select-Object -ExpandProperty ProcessId" 2^>nul`) do (
    echo    本项目虚拟环境进程 PID %%p, 正在结束 ...
    taskkill /PID %%p /F >nul 2>&1
    set FOUND=1
)

echo.
if "!FOUND!"=="1" (
    echo    已停止。
    echo.
    echo    若浏览器还开着页面, 刷新一次即可确认服务已关闭。
) else (
    echo    没有发现正在运行的服务。
    echo.
    echo    提示: 若确认服务在跑却找不到, 可手动执行
    echo          tasklist ^| findstr python
    echo          taskkill /PID ^<PID^> /F
)
echo.
echo ============================================================
%SystemRoot%\System32\timeout.exe /t 4 /nobreak >nul 2>&1
endlocal
