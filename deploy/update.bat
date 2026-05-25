@echo off
REM ============================================================
REM Conciliacion - Actualizar a la ultima version
REM ============================================================
REM Pull del repo, instala deps si cambiaron, aplica schema, build y restart.

setlocal
set ROOT=%~dp0..
cd /d "%ROOT%"

echo.
echo ==^> 1. git pull
git pull
if errorlevel 1 goto :err

echo.
echo ==^> 2. npm install
call npm install --no-audit --no-fund
if errorlevel 1 goto :err

echo.
echo ==^> 3. prisma generate
call npx prisma generate
if errorlevel 1 goto :err

echo.
echo ==^> 4. prisma db push
call npx prisma db push
if errorlevel 1 goto :err

echo.
echo ==^> 5. npm run build
call npm run build
if errorlevel 1 goto :err

echo.
echo ==^> 6. pm2 restart
call pm2 restart conciliacion --update-env
if errorlevel 1 goto :err

echo.
echo =========================================================
echo   ACTUALIZACION COMPLETA
echo =========================================================
call pm2 status
echo.
goto :end

:err
echo.
echo [ERROR] La actualizacion fallo. Revisa el mensaje de arriba.
exit /b 1

:end
endlocal
