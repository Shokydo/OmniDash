@echo off
REM ============================================================
REM  OmniDash - панель управления серверами (замена Pterodactyl)
REM  Батник для локального запуска на Windows: посмотреть
REM  оформление и функционал без Docker и без сборки.
REM
REM  Использование:
REM    start.bat              - меню (обычный запуск / dev / сброс)
REM    start.bat 7777         - запустить сразу на порту 7777
REM    start.bat dev          - dev-режим: автоперезапуск при правках
REM    start.bat dev 7778     - dev-режим на порту 7778
REM    start.bat reset        - сбросить демо-данные и запустить
REM    start.bat --help       - справка
REM
REM  Требования: Node.js >= 18.17 (https://nodejs.org)
REM  Зависимостей у панели нет - npm install для запуска НЕ нужен.
REM ============================================================

chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
title OmniDash - панель управления серверами
cd /d "%~dp0"

set "PORT=7777"
set "HOST=0.0.0.0"
set "MODE=normal"
set "OPEN_BROWSER=1"

if /i "%~1"=="--help" goto :help
if /i "%~1"=="help" goto :help
if /i "%~1"=="-h" goto :help
if /i "%~1"=="dev" (
    set "MODE=dev"
    if not "%~2"=="" set "PORT=%~2"
    goto :checks
)
if /i "%~1"=="reset" (
    set "MODE=reset"
    goto :checks
)
if not "%~1"=="" (
    set "PORT=%~1"
    goto :checks
)

:menu
cls
echo.
echo   ============================================================
echo     OmniDash - панель управления серверами
echo     Замена Pterodactyl без Docker: консоль, файлы, бэкапы,
echo     доступы, порты, лимиты, сроки, расписание, журнал.
echo   ============================================================
echo.
echo     [1] Запустить панель          http://localhost:7777
echo     [2] Запустить в DEV-режиме   (автоперезапуск при правках кода)
echo     [3] Запустить на другом порту (спросит номер порта)
echo     [4] Сбросить демо-данные      (data -^> data-backup, пересоздадутся)
echo     [5] Проверить окружение       (Node.js, Python, порт, файлы)
echo     [0] Выход
echo.
set /p "CHOICE=  Выберите пункт и нажмите Enter: "
if "%CHOICE%"=="1" (
    set "MODE=normal"
    set "PORT=7777"
    goto :checks
)
if "%CHOICE%"=="2" (
    set "MODE=dev"
    set "PORT=7777"
    goto :checks
)
if "%CHOICE%"=="3" (
    set /p "PORT=  Введите порт (например 8080): "
    if "%PORT%"=="" set "PORT=7777"
    set "MODE=normal"
    goto :checks
)
if "%CHOICE%"=="4" (
    set "MODE=reset"
    goto :checks
)
if "%CHOICE%"=="5" (
    set "MODE=checkonly"
    goto :checks
)
if "%CHOICE%"=="0" goto :bye
echo.
echo   Неизвестный пункт: "%CHOICE%". Попробуйте ещё раз.
timeout /t 2 /nobreak >nul
goto :menu

:checks
cls
echo.
echo   ============================================================
echo     OmniDash - проверка окружения
echo   ============================================================
echo.

echo   [1/5] Проверка Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [!] Node.js НЕ найден в PATH.
    echo.
    echo   Установите Node.js LTS ^(>= 18.17^) с https://nodejs.org
    echo   После установки перезапустите этот батник.
    echo   Подсказка: при установке оставьте галочку
    echo   "Automatically install the necessary tools".
    echo.
    start "" "https://nodejs.org/en/download" 2>nul
    pause
    goto :bye
)
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo         Найден: %NODE_VER%
for /f "tokens=1 delims=." %%a in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%a"
if defined NODE_MAJOR (
    if !NODE_MAJOR! LSS 18 (
        echo.
        echo   [!] Слишком старая версия Node.js: %NODE_VER%.
        echo   Нужна ^>= 18.17. Обновите: https://nodejs.org
        echo.
        start "" "https://nodejs.org/en/download" 2>nul
        pause
        goto :bye
    )
)
echo         OK: версия подходит ^(требуется ^>= 18.17^).
echo.

echo   [2/5] Проверка файлов проекта...
if not exist "%~dp0server.js" (
    echo.
    echo   [!] Не найден server.js рядом с батником.
    echo   Батник должен лежать в корне репозитория OmniDash,
    echo   где находятся server.js, package.json и папка public.
    echo   Текущая папка: %CD%
    echo.
    pause
    goto :bye
)
if not exist "%~dp0public\index.html" (
    echo.
    echo   [!] Не найден public\index.html - репозиторий повреждён или неполный.
    echo.
    pause
    goto :bye
)
if not exist "%~dp0package.json" (
    echo   [!] Предупреждение: нет package.json - возможно, неполная копия.
)
echo         OK: server.js, public\index.html на месте.
echo.

echo   [3/5] Проверка порта %PORT%...
netstat -ano 2>nul | findstr /C:":%PORT% " >nul 2>&1
if not errorlevel 1 (
    echo.
    echo   [!] Порт %PORT% уже занят другим процессом.
    echo   Найдите его:  netstat -ano ^| findstr :%PORT%
    echo   Или укажите другой порт при запуске:  start.bat 8080
    echo.
    set /p "NEWP=  Введите другой порт (Enter - выйти): "
    if "%NEWP%"=="" goto :bye
    set "PORT=%NEWP%"
    echo         Используем порт %PORT%.
)
echo         OK: порт %PORT% свободен.
echo.

echo   [4/5] Проверка Python ^(нужен только для демо Price Parser^)...
where python3 >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%v in ('python3 --version 2^>nul') do echo         Найден python3: %%v
    goto :python_ok
)
where python >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%v in ('python --version 2^>nul') do echo         Найден python: %%v
    echo         [!] Но шаблон Python-бота запускает команду "python3".
    echo             На Windows её обычно нет - сервер Price Parser не стартует.
    echo             Остальные демо-серверы ^(Paper, Node-бот^) работают без Python.
    echo             Лечение: установите Python с https://www.python.org
    echo             и добавьте алиас python3, либо поменяйте стартовую команду
    echo             шаблона в админке на "python -u ...".
    goto :python_ok
)
where py >nul 2>&1
if not errorlevel 1 (
    echo         Найден лаунчер py ^(Python Launcher^).
    echo         [!] Команда "python3" всё равно не найдётся - см. выше.
    goto :python_ok
)
echo         Python не найден - это нормально для просмотра панели.
echo         Сервер Price Parser ^(python-бот^) не запустится, остальные - да.
:python_ok
echo.

echo   [5/5] Проверка npm ^(для запуска НЕ нужен^)...
where npm >nul 2>&1
if errorlevel 1 (
    echo         npm не найден - панель всё равно запустится через node напрямую.
    echo         npm нужен только для тестов и dev-зависимостей.
) else (
    for /f "tokens=*" %%v in ('npm -v 2^>nul') do echo         npm %%v
    echo         OK.
)
echo.

if /i "%MODE%"=="checkonly" (
    echo   ============================================================
    echo     Проверка завершена. Всё готово к запуску.
    echo   ============================================================
    echo.
    pause
    goto :menu
)

if /i "%MODE%"=="reset" (
    echo   ============================================================
    echo     Сброс демо-данных
    echo   ============================================================
    echo.
    if exist "%~dp0data" (
        for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value 2^>nul') do set "DT=%%a"
        if not defined DT set "DT=%RANDOM%"
        set "DT=!DT:~0,8!"
        echo   Старая папка data будет переименована в data-backup-!DT!
        echo   ^(ничего не удаляется безвозвратно - можно вернуть обратно^).
        echo.
        set /p "CONF=  Продолжить? [Y/N]: "
        if /i not "!CONF!"=="Y" (
            echo   Отменено.
            pause
            goto :menu
        )
        ren "%~dp0data" "data-backup-!DT!" 2>nul
        if errorlevel 1 (
            echo   [!] Не удалось переименовать data. Возможно, панель ещё запущена.
            echo   Остановите её ^(Ctrl+C^) и попробуйте снова.
            pause
            goto :menu
        )
        echo   OK: демо-данные будут пересозданы при старте.
        echo.
    ) else (
        echo   Папки data нет - сбрасывать нечего, просто запустим панель.
        echo.
    )
    set "MODE=normal"
)

if /i "%MODE%"=="dev" (
    if not exist "%~dp0node_modules" (
        echo   DEV-режим: dev-зависимости ^(esbuild, jsdom^) не установлены.
        echo   Для работы панели они не нужны, но для тестов - да.
        echo   Устанавливаем... ^(можно пропустить, нажав Ctrl+C^)
        echo.
        call npm install --ignore-scripts --no-audit --no-fund
        echo.
    )
)

echo   ============================================================
echo     Запуск OmniDash
echo   ============================================================
echo.
echo     Режим:  %MODE%
echo     Адрес:  http://localhost:%PORT%
echo     Папка:  %CD%
echo     Данные: %CD%\data  ^(создадутся при первом запуске^)
echo.
echo     Логины по умолчанию ^(демо^):
echo       admin  / omnidash    - администратор, видно всё
echo       steve  / steve123    - пользователь, 3 сервера
echo       mira   / mira123     - пользователь, 2 сервера
echo       kotik  / kotik123    - сервер с истёкшим сроком
echo.
echo     Остановка: Ctrl+C в этом окне.
echo     Если Windows спросит про брандмауэр для node.exe -
echo     разрешите для частных сетей.
echo.
echo   ============================================================
echo.

if "%OPEN_BROWSER%"=="1" (
    start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" ""http://localhost:%PORT%"" 2>nul"
)

set "PORT=%PORT%"
set "HOST=%HOST%"

if /i "%MODE%"=="dev" (
    echo   [dev] Запуск через tools\dev.js - следим за server.js и core\
    echo.
    node "%~dp0tools\dev.js"
) else (
    node "%~dp0server.js"
)

set "EXITCODE=%ERRORLEVEL%"
echo.
echo   ============================================================
echo     Панель остановлена ^(код выхода: %EXITCODE%^).
echo   ============================================================
echo.
echo   Данные сохранены в: %CD%\data
echo   Для сброса демо запустите:  start.bat reset
echo.
pause
goto :bye

:help
echo.
echo   OmniDash - запуск панели на Windows
echo.
echo   Использование:
echo     start.bat              меню выбора
echo     start.bat 7777         запуск на порту 7777
echo     start.bat dev          dev-режим ^(автоперезапуск при правках^)
echo     start.bat dev 7778     dev-режим на порту 7778
echo     start.bat reset        сброс демо-данных и запуск
echo     start.bat --help       эта справка
echo.
echo   Требования: Node.js ^>= 18.17 - https://nodejs.org
echo   Зависимостей нет, npm install не нужен.
echo   После запуска откройте http://localhost:7777
echo   Логин: admin / omnidash
echo.
pause
goto :bye

:bye
endlocal
exit /b 0
