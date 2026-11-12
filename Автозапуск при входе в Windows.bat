@echo off
chcp 65001 >nul
rem Добавляет ярлык сервера в автозагрузку текущего пользователя. Запустите ещё раз, чтобы убрать.
cd /d "%~dp0"
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Карта сети - сервер.lnk
if exist "%LNK%" (
  del "%LNK%"
  echo Автозапуск отключён.
) else (
  powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath=(Join-Path (Get-Location) 'Карта сети - сервер.bat'); $s.WorkingDirectory=(Get-Location).Path; $s.WindowStyle=7; $s.Save()"
  if exist "%LNK%" (echo Готово: сервер будет запускаться при входе в Windows.) else (echo Не получилось создать ярлык автозапуска.)
)
echo.
pause
