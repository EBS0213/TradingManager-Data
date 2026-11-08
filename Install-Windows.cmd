@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TM_TARGET=%~1"
if not defined TM_TARGET set /p "TM_TARGET=설치된 TradingManager 폴더 경로를 입력하세요: "
node --max-old-space-size=4096 "%~dp0restore.mjs" "%TM_TARGET%"
if errorlevel 1 echo 설치 실패. 위 오류를 확인한 뒤 다시 실행하세요.
pause
