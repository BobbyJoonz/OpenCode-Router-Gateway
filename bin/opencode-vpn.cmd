@echo off
REM Dedicated OpenCode VPN Launcher (Windows)
REM Injects the active local proxy specifically for OpenCode without system-wide routing changes.

if "%OPENCODE_HTTP_PROXY_PORT%"=="" set "OPENCODE_HTTP_PROXY_PORT=10809"
if "%OPENCODE_SOCKS_PROXY_PORT%"=="" set "OPENCODE_SOCKS_PROXY_PORT=10808"

REM OpenCode's LLM runtime breaks on HTTP(S) proxy env vars (ECONNREFUSED).
REM SOCKS5 via ALL_PROXY works for the model catalog and the completion stream.
set "http_proxy="
set "https_proxy="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "all_proxy=socks5://127.0.0.1:%OPENCODE_SOCKS_PROXY_PORT%"
set "ALL_PROXY=socks5://127.0.0.1:%OPENCODE_SOCKS_PROXY_PORT%"

set "OPENCODE_BIN=C:\Users\Lenovo\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe"
if not exist "%OPENCODE_BIN%" set "OPENCODE_BIN=opencode"

"%OPENCODE_BIN%" %*
