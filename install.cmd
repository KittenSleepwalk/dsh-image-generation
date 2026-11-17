@echo off
title Install dsh-qwen-image
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
