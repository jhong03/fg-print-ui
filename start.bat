@echo off
rem ==========================================================================
rem  Launch both local services + open the operator UI.
rem  Double-click to run, or drop a shortcut in shell:startup for auto-launch.
rem  Edit PRINT_AGENT below to this PC's print-agent folder.
rem ==========================================================================

set "PATH=C:\Program Files\nodejs;%PATH%"
set "PRINT_AGENT=C:\path\to\print-agent"

rem fg-print-ui (this folder) -- npm start = node server/index.js
start "fg-print-ui" /min cmd /c "cd /d "%~dp0" && node server\index.js"

rem print-agent
start "print-agent" /min cmd /c "cd /d "%PRINT_AGENT%" && node server.js"

rem give the server a moment, then open the UI
timeout /t 4 /nobreak >nul
start "" "http://localhost:3000"

rem --- Kiosk full-screen instead? Comment the line above, uncomment below ---
rem start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk http://localhost:3000 --edge-kiosk-type=fullscreen --no-first-run
