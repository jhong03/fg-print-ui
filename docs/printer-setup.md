# Printer setup and agent integration

Open **Printer settings** from the operator screen, or visit `/settings.html`.
The **Label configuration** section edits model filters, Normal/Rework modes,
QR binding, templates, job filters and layout. See [Label configuration](label-configuration.md).
Restart both updated Node services once before using the new integration. An
older running backend cannot provide the new settings and queue endpoints.

## Setup

1. Start the updated print-agent. Its current legacy config is supported.
2. Open Printer settings. The default local agent address comes from `AGENT_URL`.
3. Add printers with a stable ID, friendly name, printer language and connection.
   Windows printers must already be installed and shared; use **Find Windows
   printers** to see their names and shares. TCP printers use an IP/hostname and
   port, normally 9100.
4. Save terminal and printers. Check status, then optionally test on suitable
   media. TSPL connection tests use a 50 x 30 mm label; ESC/POS tests use a short
   receipt. A test being sent does not confirm physical paper output.
5. Select an enabled TSPL printer for each label destination and save assignments.

Under **Label assignments**, the **Show P1**, **Show P3**, etc. checkboxes control
which groups appear on this computer's operator screen. Individual **Show**
checkboxes within each group control its label destinations, including Normal
and Rework separately. Both the group and the label must be checked for a label
to appear. Hiding a group preserves each label's individual choice.
Click **Save visibility** and return to printing. Printer assignments are grouped
under the same headings
and remain editable in Settings even for hidden groups. Visibility can be saved
when print-agent is offline. Hidden groups and labels keep their configuration, queued jobs
and auto-print behavior; this is a display preference, not a print-disable rule.
If all labels are hidden, manual input/scanning is disabled until a group and
one of its labels are shown again. Settings always remains accessible. Other open operator windows
pick up the preference on page reload.

The Settings page can configure and test ESC/POS printers, but existing MES label
templates render TSPL. The UI therefore excludes receipt printers from label
assignment dropdowns. Supporting receipt layouts is separate work.

Printer changes apply to new jobs immediately. Terminal ID, relay, HTTP port and
scale changes require restarting print-agent. The page reports pending restart
fields. If the HTTP port changes, reconnect using the new address after restart.

## Local settings and credentials

Printer definitions are saved by print-agent into its own config, with validation,
revision checking and a backup. Label assignments and the selected local agent
address live in `printer-settings.json`, which is ignored by Git. The tracked
`locations.json` retains its template and production-flow definitions.

Only a local HTTP agent can be administered from Settings. Existing manually
configured remote destinations can still print through compatible updated agents;
remote agent administration is not exposed by this page.

The UI backend reads the management token from `AGENT_MANAGEMENT_TOKEN`,
`PRINT_AGENT_MANAGEMENT_TOKEN`, or `AGENT_MANAGEMENT_TOKEN_FILE`. Without an
override, it reads `management-token` in `PRINT_AGENT_DATA_DIR` or the sibling
`../print-agent` folder. Start print-agent to create that token file. It is never
returned to the browser, stored in localStorage or committed to Git.

Settings and spooler management require local, same-origin requests. Browser
requests are proxied by the UI backend; the browser never calls the agent's
authenticated management API directly.

For future packaging, `FG_UI_DATA_DIR` moves UI settings, print queues, binding
queues and auto-print state into a writable application-data folder. Set
`PRINT_AGENT_DATA_DIR` for the corresponding agent directory. Existing paths
remain the default. Installation/packaging and migration of existing queues are
not part of this change.

## Queue behavior

print-ui retains queue ownership, pause/resume and retry decisions. Each printer
has its own queue and worker. Tabs sharing a printer share its queue. Use the
Printer queue selector to choose which printer the controls apply to.

Queued jobs retain label options and the chosen printer ID. Once the agent
registry is reachable, the job also retains the resolved connection. Settings
cannot redirect/remove a printer referenced by pending jobs. New submissions are
briefly rejected while a settings save is in progress to prevent a routing race.
Assignments may change for new jobs without moving existing work.

Submissions use `retryOwner:client` and a persistent unique submission ID. A lost
acceptance reply is retried with the same ID and exact TSPL bytes. Polling an
accepted job after restart does not create a new job. Replay is stopped after
23 hours, within the agent's 24-hour deduplication window.

An uncertain send is held for review. **Mark as sent** acknowledges that the label
already came out. **Retry after checking** prepares a new attempt, then the
operator presses Resume. Check for a physical label and any remaining spool job
before retrying. A known not-sent failure can be retried with Resume.

Windows jobs still in the spooler remain held and are reconciled on Resume;
they are not automatically cleared and resent. Windows may release a held job
when the printer recovers. **Clear printer spooler** explicitly clears the
selected printer and moves affected jobs into review to prevent a blind reprint.
In-flight jobs cannot simply be discarded. Network status only establishes
reachability. The screen reports **Sent to printer**, not confirmed printing.

The current Welding to Painting resolution, normal/rework QR gates and database
binding behavior are retained.

## Verification

Run `npm test`. Unit tests exercise independent queues, ordering, frozen routing,
restart recovery, lost replies, uncertain sends and settings protection. With
the sibling print-agent checkout available, integration tests run both real
backends with temporary files, mock job data, a local MES-template stand-in and
TCP stand-in printers. No production config or physical printer is used.

When Playwright is available, the integration suite also checks Chrome setup
forms, assignment saving, protocol filtering, responsive layout and operator
navigation. Set `FG_UI_QA_DIR` to retain screenshots. Physical USB and production
printer tests remain necessary before deployment.
