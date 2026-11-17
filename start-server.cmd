@echo off
title ComfyUI for dsh-qwen-image
REM 手动启动 ComfyUI（仅当插件配置 comfy.mode = external 时用；mode=auto 时插件会自己起）
REM Usage: set "DSH_COMFY_ROOT=<ComfyUI root>" first, or edit the two lines below.
if not defined DSH_COMFY_ROOT (
  echo [ERROR] DSH_COMFY_ROOT is not set. Point it at your ComfyUI root directory.
  pause
  exit /b 1
)
set "PY=%DSH_COMFY_ROOT%\.venv\Scripts\python.exe"
set "MAIN=%DSH_COMFY_ROOT%\main.py"
if not exist "%PY%" (
  echo [ERROR] python not found: %PY%
  echo Edit this file if ComfyUI is installed somewhere else.
  pause
  exit /b 1
)
echo Starting ComfyUI on http://127.0.0.1:8188  (keep this window open)
"%PY%" "%MAIN%" --port 8188 --listen 127.0.0.1
echo.
echo ComfyUI exited.
pause
