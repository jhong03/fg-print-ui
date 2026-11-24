# Auto Print settings

Open **Printer settings → Auto Print** in the sidebar, or **File → Auto Print**
in the packaged desktop app. Enable it, select the labels handled by this computer,
set the completion-check interval (1–300 seconds), and click **Save Auto Print**.
Changes apply immediately. The status area shows whether the watcher is running,
its last check, its last queued job and any error.

Each selected label needs model filters. One model can have only one selected
Auto Print destination on this computer. Rework labels stay manual. Labels with
a stock-location filter only accept completions at that stock location. Green/Red
QR labels stage the job for binding; selecting them does not bypass scanning.
Existing printer assignments still determine the output printer. Hiding a label
on the operator screen does not disable its watcher.

Turning Auto Print on, reenabling it, or adding watched labels starts those routes
after the latest existing completion in the database. Previously completed jobs
are not replayed. Existing watched routes retain their position when another label
is added or the check interval changes. Normal app restarts retain the completion
position and printed-job history, so unfinished monitoring can resume. Turning it
off stops future detection; already queued print/binding jobs remain in their queues.

Settings are saved in `%LOCALAPPDATA%\FGPrint\ui\auto-print-settings.json` in the
packaged app. Existing `.env` defaults (`AUTO_PRINT_ENABLED`, `AUTO_PRINT_LOCATIONS`,
`AUTO_PRINT_POLL_MS`) are used until the first frontend save. Saved settings then
override those defaults and survive app updates. Completion history remains in
`auto-print-state.json`; changing settings never clears printed-job IDs.

Label configuration changes are checked against active Auto Print selections.
Remove a label from Auto Print, or disable Auto Print, before removing its model
filters, changing it to Rework, or removing that watched label entirely.

The backend cancels an in-flight poll when settings change, preserves deduplication
history, validates selected routes and applies revision checks to conflicting saves.
Unit tests cover migration, history, enable/disable boundaries, interrupted polls,
QR staging, and startup. Integration tests use only mock completions and stand-in
printers. The UI does not expose the developer trigger that can enqueue a real job.
