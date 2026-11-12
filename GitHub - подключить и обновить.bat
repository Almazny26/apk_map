@echo off
chcp 65001 >nul
rem Связывает эту папку с репозиторием GitHub Almazny26/apk_map и подтягивает последние изменения
rem (в том числе свежий APK в папке apk). Папки data и data-demo с базой, пользователями и журналом
rem не трогаются и в GitHub не попадают.
cd /d "%~dp0"
where git >nul 2>&1
if errorlevel 1 (
  echo Git не установлен. Скачайте и установите Git for Windows: https://git-scm.com/download/win
  echo При установке все параметры можно оставить по умолчанию. Потом запустите этот файл ещё раз.
  pause
  exit /b 1
)
if not exist ".git" (
  echo Подключаю папку к GitHub...
  git init -q -b main
  git config core.autocrlf false
  git config core.filemode false
  git config core.quotepath false
  git remote add origin https://github.com/Almazny26/apk_map.git
  git fetch origin main || goto err
  git reset -q --mixed origin/main || goto err
  git branch -q --set-upstream-to=origin/main main
  echo Готово: папка связана с репозиторием Almazny26/apk_map.
) else (
  echo Получаю обновления из GitHub...
  git pull --ff-only origin main || goto err
)
echo.
git log -1 --format="Текущая версия: %%h %%s (%%cd)" --date=format:"%%d.%%m.%%Y %%H:%%M"
git status --short
echo.
echo Если сервер запущен, перезапустите его, чтобы обновление вступило в силу.
pause
exit /b 0
:err
echo.
echo Не получилось. Если GitHub попросил войти - войдите в свой аккаунт и запустите файл ещё раз.
echo Если пишет про изменённые файлы - сообщите, что именно он вывел.
pause
exit /b 1
