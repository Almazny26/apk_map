@echo off
chcp 65001 >nul
title Карта сети — совместная работа
call "%~dp0Карта сети.bat" --shared %*
