@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".git" (
 echo Скачайте проект через git clone https://github.com/Almazny26/karta-seti-gpt.git
 pause
 exit /b 1
)
for /f "delims=" %%R in ('git remote get-url origin') do set "REMOTE=%%R"
if not "%REMOTE%"=="https://github.com/Almazny26/karta-seti-gpt.git" (
 echo Папка подключена к другому репозиторию. Обновление остановлено.
 pause
 exit /b 1
)
git pull --ff-only origin main
if errorlevel 1 (
 echo Не удалось обновить. Сохраните местные изменения перед повторным запуском.
 pause
 exit /b 1
)
echo Обновление завершено. Перезапустите программу.
pause
