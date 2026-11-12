@echo off
chcp 65001 >nul
title Карта сети - сервер ДЕМО
cd /d "%~dp0"
where python >nul 2>nul && (python run.py --demo --port 8791 %* & goto end)
where py >nul 2>nul && (py run.py --demo --port 8791 %* & goto end)
echo Не найден Python 3. Установите Python 3.8 или новее (при установке отметьте "Add python.exe to PATH").
:end
echo.
echo Сервер остановлен.
pause
