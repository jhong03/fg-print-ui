# Start both node services hidden, open the UI in a dedicated window,
# and terminate the services when that window is closed.
# Edit the three paths below per machine.

$node       = "C:\Program Files\nodejs\node.exe"
$fgUi       = "C:\Users\hup\Downloads\fg-print-ui-main\fg-print-ui-main"
$printAgent = "C:\Users\hup\Downloads\print-agent-main\print-agent-main"
$url        = "http://localhost:3000"

# --- start services hidden, capture their PIDs ---
$ui    = Start-Process -FilePath $node -ArgumentList "server\index.js" -WorkingDirectory $fgUi       -WindowStyle Hidden -PassThru
$agent = Start-Process -FilePath $node -ArgumentList "server.js"       -WorkingDirectory $printAgent -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 4

# --- open UI in its own Chrome window (app mode = single window, maximized) ---
$chrome  = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path $env:LOCALAPPDATA "fgui-window"
$browser = Start-Process -FilePath $chrome -ArgumentList "--app=$url","--start-maximized","--user-data-dir=`"$profile`"" -PassThru

# Kiosk full-screen instead? comment the line above, uncomment below:
# $browser = Start-Process -FilePath $chrome -ArgumentList "--kiosk",$url,"--no-first-run","--user-data-dir=`"$profile`"" -PassThru

# --- block until the UI window is closed, then stop both services ---
$browser.WaitForExit()
Stop-Process -Id $ui.Id    -Force -ErrorAction SilentlyContinue
Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue
