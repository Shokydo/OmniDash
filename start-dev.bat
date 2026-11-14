@echo off
REM OmniDash - быстрый запуск в DEV-режиме (автоперезапуск при правках)
REM Просто вызывает start.bat dev. Порт можно передать: start-dev.bat 7778
chcp 65001 >nul 2>&1
cd /d "%~dp0"
if "%~1"=="" (
    call "%~dp0start.bat" dev
) else (
    call "%~dp0start.bat" dev %~1
)
