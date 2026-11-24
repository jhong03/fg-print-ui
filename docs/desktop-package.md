# Windows desktop package

The portable **Label Printer.exe** desktop app starts the UI and print-agent with a
bundled Windows x64 Node runtime and displays the interface in its own Electron
window. A simple printer icon is embedded in the Windows EXE and used by the app
window and taskbar. No Edge, Chrome, installed browser, or external browser profile is used.
The File menu provides printing, settings, logs and exit. Closing the app and
confirming Exit stops both child services. Database, MES and relay connections
continue to work through the existing backends.
**File → Label configuration** opens the built-in editor for the per-terminal
`locations.json`; see [Label configuration](label-configuration.md).
Settings use a sidebar with Printers, Label assignments, Label configuration,
Auto Print, and Terminal & agent. Each section retains its draft while switching.
Leaving with unsaved label or Auto Print edits opens a native Stay / Discard prompt.
Choosing Stay preserves the page; saved settings return to printing directly.
See [Auto Print settings](auto-print-settings.md) for live completion watching.

The renderer has no Node integration or privileged preload. It uses the existing
local HTTP API. Navigation is limited to the local UI origin, external/new windows
and embedded webviews are blocked, permissions are denied, and a content security
policy is applied. Its saved profile lives under the existing app data folder.

First use creates `%LOCALAPPDATA%\FGPrint` with a generated terminal ID, new local
management token, empty printer registry, and fresh queues. The package seeds the
plant `.env`, relay URL and label definitions from the build machine. It does not
copy that machine's printers, assignments, tokens, queues, locks or scale connection.
User data is retained across app-folder upgrades; seed files never overwrite it.
This is a separate installation and does not migrate existing production jobs.
The existing FGPrint data-folder name is retained across the Label Printer rename.

Windows drivers/shares and network access to the database/MES remain prerequisites.
Only current TSPL layouts are assignable to production labels. The package needs
Windows 10/11 x64 and PowerShell; Node and the rendering runtime are bundled,
and npm is not needed. This is a desktop app folder rather than an installer or
automatically started Windows service.

## Build

Install both repositories' dependencies on Windows x64 with the Node version you
will bundle. Native print-agent dependencies must load under that same runtime.
Run `npm ci --prefix scripts/desktop`, then
`node scripts/desktop/node_modules/electron/install.js` to obtain the pinned
Electron distribution (the download checks the published checksums).
Provide the Node runtime's official full license notice using `FG_NODE_LICENSE_FILE`, then run
`npm run build:desktop`. The default output is `.build/Label Printer`. An existing
output folder is refused rather than overwritten. Use `-- --out C:\AnotherFolder`
to choose another new folder; set `PRINT_AGENT_SOURCE` for a non-sibling checkout.
Electron's distribution is copied into the package, its executable is named
`Label Printer.exe`, and `resources/app/main.js` owns the window and service lifecycle.
The build generates a multi-resolution ICO from `scripts/desktop/assets/label-printer.svg`
using the print-agent's existing Sharp dependency. RCEdit embeds the icon and Windows
product/file details into the EXE. Both the runtime and resource editor are pinned
in `scripts/desktop/package-lock.json`.
The Windows .NET Framework compiler is no longer needed.

This plant build includes database credentials in `defaults/ui.env`. Keep it
private and distribute only to authorized terminals. It is not a public build.
Dependency license notices are retained. The full app folder must travel together.

## Checks

`npm test` verifies both services using temporary state and stand-in printers.
For an additional packaged-runtime check, set `FG_PRINT_DATA_DIR` to a **new
temporary directory** and run `Label Printer.exe --smoke`. This starts both bundled
services on free ports with a mock database, no relay, no printers and no automatic
printing; checks authenticated settings, destination loading and visibility;
writes `smoke-report.json`; and stops the services. Never use an existing production
data folder for this check because it deliberately changes the test config.

Run the check again with that same test folder to verify the terminal ID survives
restart. With Playwright available and `FG_PRINT_PACKAGE` pointing to the build,
the package tests also open the real Electron window and exercise its settings,
saved visibility, renderer isolation, blocked popups, and shutdown.
For production, do not set `FG_PRINT_DATA_DIR` unless deliberately choosing a
different persistent data location. Port conflicts show an error and do not stop
or attach to unrelated services. Logs are under the chosen data directory.
