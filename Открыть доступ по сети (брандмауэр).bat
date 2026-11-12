@echo off
chcp 65001 >nul
rem Разрешает входящие подключения к серверу «Карта сети» (порт из data\config.json, по умолчанию 8790).
net session >nul 2>&1
if errorlevel 1 (
  echo Нужны права администратора - Windows сейчас спросит разрешение...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
set PORT=8790
for /f %%p in ('powershell -NoProfile -Command "try{$c=Get-Content -Raw -Encoding UTF8 'data\config.json'|ConvertFrom-Json; if($c.port){$c.port}}catch{}"') do set PORT=%%p
netsh advfirewall firewall delete rule name="Карта сети" >nul 2>&1
netsh advfirewall firewall add rule name="Карта сети" dir=in action=allow protocol=TCP localport=%PORT% profile=any >nul
if errorlevel 1 (
  echo Не получилось добавить правило брандмауэра.
) else (
  echo Готово: брандмауэр Windows пропускает подключения к серверу «Карта сети» на порт %PORT%.
)
echo.
echo Чтобы сервер был виден из интернета, этот же порт нужно пробросить на роутере
echo на адрес этого компьютера (см. README.md, раздел «Доступ из интернета»).
echo.
pause
