@echo off
chcp 65001 >nul
echo Starting SEBT Dashboard...
powershell -Command "npm run dev"
