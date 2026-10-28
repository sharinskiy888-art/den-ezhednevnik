@echo off
chcp 65001 >nul
title Сервер «День»
cd /d "%~dp0"
echo Сервер «День» работает, пока открыто это окно: http://localhost:8787/
echo Чтобы остановить сервер, закройте это окно.
echo.
"%~dp0python\python.exe" "%~dp0den.py" open
if errorlevel 1 (
  echo.
  echo Сервер остановился с ошибкой. Сфотографируйте это окно и пришлите.
  pause
)
