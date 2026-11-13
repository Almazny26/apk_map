@echo off
chcp 65001 >nul
title Карта сети
cd /d "%~dp0"
rem Ищем настоящий Python: сначала лаунчер py, потом python. Заглушка Microsoft Store проверку не проходит.
set PY=
py -3 -c "import sys" >nul 2>nul && set PY=py -3
if not defined PY python -c "import sys" >nul 2>nul && set PY=python
if not defined PY (
  echo На этом компьютере не установлен Python 3.
  echo.
  echo Установите его: запустите установщик python-3.x-amd64.exe ^(есть на рабочем столе
  echo или на python.org^), в первом окне поставьте галочку "Add python.exe to PATH"
  echo и нажмите Install Now. Потом запустите этот файл ещё раз.
  echo.
  pause
  exit /b 1
)
%PY% run.py %*
echo.
echo Программа закрыта.
pause
