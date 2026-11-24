# Label configuration in the app

Open **File → Label configuration**, or select **Label configuration** in the settings sidebar.
Select a label, make changes, and click **Save label configuration**. Return to
printing to reload the destination tabs and their settings. Other open operator
windows need a refresh. Print-agent can be offline while editing definitions.

The editor supports all fields currently read from `locations.json`:

| Section | Fields |
| --- | --- |
| Label and models | `id`, `name`, `group`, `templateId`, `models`, `mode`, `modeGroup` |
| QR binding and job flow | `requireQrBinding`, `reworkQrBinding`, `weldingToPainting`, `doneOnly`, `processCodePrepend`, `toLocation`, `qrWorkcell` |
| Label layout | `variant`, `barcodeNudge`, `upright`, `boldTitle`, `boldText` |
| Advanced printer routing | `agentUrl`, `printerId`, `printerType` |

IDs are generated for added/duplicated labels, editable before the first save,
and then locked in the form so existing assignments and jobs remain linked.
The Add, Duplicate, Remove and Move buttons edit the draft. Saving applies the
whole draft; **Discard label edits** reloads the last saved version.

Normal and Rework labels can share a mode group to appear as one operator page.
A shared mode group must have one Normal and one Rework label in the same group.
Selecting **Require Green Start + Red End QR** greys out and disables **Require
Black Rework QR**, and vice versa. Untick the selected checkbox to enable the other
choice. Leave both unticked for no binding. The binding must match the selected mode.
Leak Test → Painting applies to the Normal flow. It uses the Leak Test job's linked
Painting job for the label. Its **Process code prefix** is editable only while this
flow is enabled; turning the flow off keeps the saved prefix for later use.
**Completed jobs only** restricts job searches and printing to jobs marked completed
in the database. Short descriptions appear beside each QR and job-flow setting.

**Stock location** lists `Id`, `Name` and `Code` from the connected Avelon-Yollink
database's `dbo.StockLocation` table, restricted to `Active = 1`. Choose a location
to filter jobs by `Job.ToLocationId`, or **Any location** to remove that filter.
**Refresh locations** reloads the list. New assignments are checked against the
active database rows when saving. An existing unavailable/inactive ID stays visible
and is preserved unless changed, including during a database outage. Mock mode
uses sample locations; the legacy PostgreSQL adapter has no StockLocation mapping.

Models accept commas or new lines and are normalized to uppercase. A blank list
allows all models for manual lookup. Automatic completion routing still follows
the labels selected in **Auto Print** (using the original environment defaults
until the first save there); adding a label does not automatically make this terminal watch it. QR workcell is
stored for reference; it does not change the existing QR tag validation rules.

Printer selection normally belongs in **Label assignments**. Its saved local
assignment overrides the optional raw per-label printer ID. Current templates
still require TSPL printers; choosing a legacy type does not add receipt layouts.

The packaged app edits `%LOCALAPPDATA%\FGPrint\ui\locations.json`, and keeps the
previous configuration in `locations.json.bak`. Changes survive app-folder updates.
The initial `defaults/locations.json` is only a first-run seed. A development
server uses `LOCATIONS_FILE` when set, otherwise the checkout's `locations.json`.

Writes are validated, atomic and protected against conflicting edits in another
window. Extra existing fields are retained. Existing print jobs keep their frozen
render/routing options. A label with queued prints cannot be removed. Finish and
clear its QR binding list before editing/removing it, including sent binding rows
that could still be reprinted. Removed explicit IDs return an error rather than
falling back to a different label or printer. A request preparing a print against
changed settings must be refreshed and retried.
