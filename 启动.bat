@echo off
setlocal
cd /d "%~dp0"
set "PORT=8123"
set "URL=http://127.0.0.1:%PORT%/index.html"

rem 已有服务在跑就直接开浏览器，不重复启动
netstat -ano | findstr "127.0.0.1:%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto OPENONLY

rem 找一个可用的 Python
set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY if exist "C://ProgramData//anaconda3//python.exe" set "PY=C://ProgramData//anaconda3//python.exe"
if not defined PY goto NOPY

echo.
echo   情绪音乐推荐系统 - 本地服务启动中
echo   地址: %URL%
echo   关闭这个窗口即停止服务
echo.
start "" "%URL%"
%PY% -m http.server %PORT% --bind 127.0.0.1
goto END

:OPENONLY
echo.
echo   服务已在运行，正在打开浏览器
echo   地址: %URL%
echo.
start "" "%URL%"
goto END

:NOPY
echo.
echo   [x] 没找到 Python，请任选一种方式：
echo       1) 安装 Python 3 后重新双击本文件
echo       2) 在本目录手动执行:  python -m http.server 8123
echo.
pause
goto END

:END
endlocal
