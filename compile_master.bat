@echo off
cd /d D:\AI_project\sebt-dashboard
arduino-cli compile --fqbn esp32:esp32:esp32-c3 master.ino
if %errorlevel% equ 0 (
    echo Compilation successful!
) else (
    echo Compilation failed!
)
pause
