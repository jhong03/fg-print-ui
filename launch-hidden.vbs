' Silent launcher: runs launch.ps1 hidden (no PowerShell console).
' launch.ps1 starts both node services, opens the UI window, and kills
' the services when that window is closed. Keep both files in the same folder.
' Put this .vbs (or a shortcut) in shell:startup.

Dim sh, ps1
Set sh = CreateObject("WScript.Shell")

' Absolute path to launch.ps1 in the repo (edit per machine):
ps1 = "C:\Users\hup\Downloads\fg-print-ui-main\fg-print-ui-main\launch.ps1"

sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
