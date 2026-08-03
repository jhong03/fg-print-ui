# P1FGUI — Project Context (full technical brief)

A self-contained explanation of what this project is and how every part works.
Written so another AI/dev with no prior context can understand and extend it.

---

## 1. What it is

A **local web app for production operators** at YOLLINK INDUSTRIES. An operator
picks a **JTC number** (a job) by typing or **scanning** it; the app pulls that
job's data from a database, shows a to-scale label preview, and prints a label on
a **TSC TE244** thermal printer (TSPL2, 203 dpi).

It runs **one instance per operator terminal**, next to that terminal's printer.
The app does **not** own the label design or the printer — it plugs into an
existing factory system:
- it **reads the label layout** from an existing **MES** (a separate web system),
- it **reads the job data** from a shared **SQL Server** database (the MES's own
  "Avelon" DB),
- it **prints** through an existing **print-agent** that sits next to the printer.

Beyond the basic lookup→print, it now has: **destination tabs** (one config, many
printer/template combos), a **resilient print queue** (hands-free scanning, pause/
resume, survives power cuts), and per-tab **label variants + print calibration**.

---

## 2. Tech stack

- **Runtime:** Node.js (v24), CommonJS (`require`, not `import`).
- **Server:** Express 4. **Frontend:** plain HTML/CSS/JS, no build step, served static.
- **DB drivers:** `mssql` (tedious) — **active**; `pg` (PostgreSQL) — alternative; `mock`.
- **Barcode (preview only):** `jsbarcode`, served locally (offline).
- **Platform:** Windows (the print-agent + spooler control use PowerShell).

---

## 3. The three external systems

| System | What it is | Where | Used for |
|---|---|---|---|
| **SQL Server** ("Avelon-Yollink" MES DB) | The MES's production DB, reached directly | `10.0.100.14\SQLEXPRESS` (see `.env` MSSQL_*) | The **values** on the label (customer, part, qty, dates, customer-order, routing) |
| **MES** ("Warehouse Console P3") | Separate React app with a visual **label designer** + template store | `http://ec2-43-217-35-209…:8081` | The **label layout** (template JSON) — positions + which field key each slot wants |
| **print-agent** | Separate Node app on each terminal, next to the printer | local `http://localhost:9000` (code at `C:\print-agent`) | We POST it **TSPL**; it drives the TSC TE244 |

> A legacy **PostgreSQL** ("bky-ejtc") is still supported as an alternative DB
> adapter but is not the active source. `DB_CLIENT` selects the adapter.

### About the MES template
- Templates are JSON, fetched via `GET /api/label-templates/{id}`.
- A template = `{ label:{widthMm,heightMm,dpi,gapMm,direction,printMethod},
  elements:[ … ] }`. Each element is `text | bar | box | barcode`, `x,y` in
  **printer dots**, with a `value` of `{kind:"static", text}` or
  `{kind:"field", field:"…", prefix?}`.
- The **field catalog** (valid keys) is at `GET /api/label-templates/fields`. It
  is **fixed** — you cannot invent a key like `jtcNumber`; only keys in the
  catalog can be bound in the designer (see §7.1 gotcha).
- Templates in use: **11** = "P1 FG Sticker (No QC Box)", **12** = "P1 FG Sticker
  (QC Box)", **13** = "P3 / Work Order", **1/2** = Work Order Assign/Scan.

### About the print-agent (`C:\print-agent`, separate repo)
- Local HTTP on `:9000`. `POST /print-label {printerType, labelData}` →
  `{success, jobId}` — this only means the job was **accepted into the agent's
  queue**, NOT that it printed. `GET /print/status/:jobId` → `SUCCESS|FAILED|…`.
  `GET /printer/status` → `{connected, online, status, hasError, queueDepth, name}`.
- Prints via **raw TCP :9100** if `tscIp` is set, else a **Windows share**
  (`tscShareName`, e.g. `TSC_TE244`). Current setup uses the **USB share**
  (`tscIp` was removed — it was an unreachable example default).
- Also connects out to a **relay** (`ws://…:3001`) for the MES's own Test-Print;
  our app does **not** use the relay — it talks to the agent locally by URL.
- **Only one agent may run per `agentId`** — a second instance makes the relay
  evict them in a loop ("Relay connected / disconnected" flapping) and breaks
  printing. Kill duplicates.

---

## 4. Directory map

```
fg-print-ui/
├── .env / .env.example       Config (.env gitignored)
├── locations.json            *** The destination "tabs" *** (+ .json.example)
├── package.json              express, dotenv, jsbarcode (+ mssql, pg)
├── server/
│   ├── index.js              Express app: all HTTP routes, startup
│   ├── mes.js                Fetch + per-template-id cache of MES templates
│   ├── agent.js              Client for a print-agent (per-call agentUrl/type)
│   ├── locations.js          Loads locations.json (tabs); list()/get(id)
│   ├── printQueue.js         *** Persistent print queue *** (worker, pause/resume)
│   ├── spooler.js            Clears the local Windows spooler (Remove-PrintJob)
│   ├── db/
│   │   ├── index.js          Adapter factory (picks by DB_CLIENT)
│   │   ├── queries.js        *** THE SQL *** (mssql + postgres query strings)
│   │   ├── mssql.js          SQL Server adapter (tedious; named-instance aware)
│   │   ├── postgres.js       pg adapter
│   │   └── mock.js           In-memory sample data
│   └── label/
│       ├── render.js         template+values → TSPL (renderTspl); upright + variant
│       ├── model.js          template+values → SVG-preview geometry (buildModel)
│       ├── mapRecord.js      DB record → MES field-key/value map
│       ├── textLayout.js     Per-line word-wrap around obstacles
│       └── barcodeLayout.js  Skip-if-empty + center-under-QC-box + width estimate
├── public/
│   ├── index.html            Tabs + search + preview + actions + queue panel
│   ├── styles.css
│   ├── app.js                Scan/select/enqueue + tabs + queue polling UI
│   └── labelPreview.js       Draws the to-scale SVG from the model
├── scripts/check-mssql.js    Standalone SQL Server connectivity tester
├── README.md / FLOW.md / PROJECT_CONTEXT.md
```

---

## 5. Core idea

```
MES template (layout + field keys)  +  DB record (values)  →  our code  →  TSPL  →  agent → printer
```

- **MES** decides which rows exist, where, and which key each wants. **No data.**
- **DB** provides the values.
- **`render.js`** re-implements the MES's own TSPL renderer (the MES render
  endpoint only injects sample data), so we can add wrapping, barcode centering,
  print calibration, upright reorientation, and label variants.

**Field matching is exact, case-sensitive.** A template element
`{value:{kind:"field", field:"partName"}}` is filled by `values["partName"]`,
built by `mapRecordToFields()`. No match → blank slot.

---

## 6. Data + print flow (end to end)

1. **Look up** — operator types/scans → `GET /api/jtc/search?q=` → `db.search()`
   → suggestions. Selecting or scanning → `GET /api/jtc?no=` → `db.getOne()` →
   the record → SVG preview (`/api/label/model`).
2. **Scan = hands-free print.** A scan (paste, or a <40 ms keystroke burst ≥4
   chars) is auto-accepted **and auto-queued**. A manual (typed) lookup only
   queues when the operator clicks **Print label**.
3. **Queue** — `POST /api/print {jtcNo, location}` enqueues. The queue worker
   renders + sends **one job at a time** to that tab's agent and confirms each
   physically printed before the next (see §9).
4. **Render** — `db.getOne()` + `getTemplate(templateId)` + `mapRecordToFields()`
   + `renderTspl()` → TSPL → `agent.printLabel(tspl, location)` → `:9000` → TE244.

---

## 7. The label rendering pipeline

### 7.1 Field mapping — `server/label/mapRecord.js`
Turns the DB row into `{ MES-field-key: value }`. **Current mapping (realigned
2026-07 so each MES key means what the catalog says it means):**
- `woNumber` ← `jtcNo` — the **JTC No** (Job.OrderNumber). Both P1's "JTC No" and
  P3's "W.O. NO." bind `woNumber`.
- `coNumber` ← `r.coNo` — the **C/O No** (CustomerOrder.OrderNumber; catalog label
  "C/O number", sample `GTN02778`). Blank on make-to-stock jobs (no customer order).
- `partName` ← the part text. The MES catalog labels `partName` as **"Part no."**,
  and there is **no separate key for a part *name*/description** — so on P1
  `partName` feeds "Part No", while P3 uses the same key for "PART NAME". A single
  value can't be both; the operator hand-maintains this LEFT key in mapRecord.
- `remarksLine1` ← `r.partNo` — a **free "Components" slot repurposed for P1
  "Part No"** (nothing else binds `remarksLine1`; P3 uses `remarksLine3/4`).
- `customer` ← `r.customer`, `model` ← `r.model` — catalog keys now exist, bound.
- `dateIssue` (`dd/mm/yyyy`, **formatted in SQL** — see §8 tz note), `qty`,
  `jtc_barcodeId` (blank ⇒ barcode skipped) — bound and working.
- `stockCode`, `processCode`, `empNo` — Work Order (P3) fields (SQL Server; §8).
- `binId`, `lotNumber`, `remarksLine2-4`, `weightLine1-4` — emitted empty.

> **This scheme needs matching MES-designer bindings** (operator's task): P1 →
> JTC No=`woNumber`, C/O No=`coNumber`, Part No=`remarksLine1`, Part Name=`partName`;
> **P3 → rebind "W.O. NO." from `coNumber` to `woNumber`** (else P3 shows the C/O No).

> **Naming gotcha:** the field-key names don't match their meaning, because the
> MES designer's catalog is **fixed** (`GET /api/label-templates/fields`) and the
> templates were bound before our involvement — `partName` means "Part no.",
> `coNumber`/`woNumber` are order numbers, and there is no `partNo`/`jtcNo`/
> `customerOrder` key. **Trust the mapRecord comments, not the key names.**

### 7.2 TSPL rendering — `server/label/render.js` → `renderTspl(template, values, opts)`
- Header `SIZE/GAP/DIRECTION/CLS/[SET PRINTMETHOD DIRECT]/OFFSET`, then one line
  per element (`TEXT/BAR/BOX/BARCODE`), then `PRINT 1,1\n`.
- **Byte-for-byte identical to the MES renderer** for text/bar/box (barcode line
  intentionally differs).
- **Upright reorientation (`makeUpright`)**: MES designs some labels *sideways*
  (portrait media, every element at rotation 270, read in landscape). When the
  majority of text is at 270, the renderer rotates the whole layout so it prints
  upright — `SIZE` swaps, coords map `(x,y)→(H−y,x)`, each rotation drops by 270.
  A template already upright is emitted unchanged. Negative coords are clamped ≥0.
- **Variants (`applyVariant`)**: `variant:'plain'` strips the **QC CHOP box + its
  "QC CHOP" caption** — but **only if a "QC CHOP" caption exists**, so it can't
  accidentally delete an unrelated box (e.g. a Work Order's border). `variant:'qc'`
  keeps everything.
- **`placedElements`**: before wrapping/positioning, barcodes are resolved to
  where they'll actually print (centered), so text wraps around their real
  position, not the template's.

### 7.3 Preview model — `server/label/model.js` → `buildModel(template, record, opts)`
Same resolve/wrap/barcode logic but returns **geometry (dots)** for the browser
SVG, so the on-screen preview matches the print. Applies the same variant.

### 7.4 Text wrapping — `server/label/textLayout.js`
`layoutText()` wraps long values at word boundaries. Each wrapped line is measured
**at its own position** against obstacles (bar/box/barcode, incl. a barcode's
human-readable digits) in the same lane. Margin depends on the blocker: barcode
~3 mm, rule line ~1 mm, label edge ~3 mm. Handles both rotation-270 and rotation-0
text.

### 7.5 Barcode — `server/label/barcodeLayout.js`
- **Skip when empty** (`jtc_barcodeId` blank ⇒ no barcode).
- **Center under the QC box** — but **only when a "QC CHOP" caption exists**;
  otherwise the barcode keeps the designer's placement (a Work Order label's
  barcode must not be dragged to the label center). Code128 width ∝ content, so
  width is estimated to center it.
- **`BARCODE_NUDGE_DOTS` / per-tab `barcodeNudge`** shifts the **printed** barcode
  horizontally (8 dots ≈ 1 mm). Because removing the QC box moves the barcode,
  the QC and Plain tabs each carry their **own** nudge.

---

## 8. Database layer — `server/db/`

Swappable via `DB_CLIENT` = `mssql` (**active**) | `postgres` | `mock`. Every
adapter exposes `search(term)`, `getOne(no)`, `close()`. The record shape the app
expects: `{ jtcNo, customer, partName, partNo, model, date, qty, barcodeId,
coNo, empNo, stockCode, processCode }`.

### SQL Server (`dbo.*`, the active source) — see `queries.js` `mssql`
`getOne` joins from `Job`:
- `Job.OrderNumber` → **jtcNo** (JTC No); `Job.Id` → **barcodeId** (the printed
  barcode encodes `*j` + Job.Id); `Job.Quantity` → qty; `Job.CreateDate` → date.
- `Job.CustomerId → Customer.Name` → customer.
- `Job.ProductId → Product` → partName (`.Name`), partNo (`.PartNumber`);
  `Product.SubProductGroupId → SubProductGroup.Name` → model.
- `Job.COItemId → CustomerOrderItem.CustomerOrderId → CustomerOrder.OrderNumber`
  → **coNo** (C/O No).
- `Job.CreatedBy → [User].EmployeeNum` → empNo.
- **Routing (Flow)** via `Job.ProductFlowRevId` (or the product's default
  `FlowRevision`): `stockCode` = the FG-output node (`FlowType=2`) `StockCode`;
  `processCode` = all process steps (`FlowType=1`) `ProcessCodeName` joined in
  flow order. ⚠ **These two are assumptions flagged in `queries.js`** — verify
  against a known-good Work Order label; the FlowType meanings may need tuning.
- **search** matches `OrderNumber LIKE @jtc` **OR** `Job.Id` (so scanning the
  printed barcode resolves the job); `GROUP BY OrderNumber` dedupes; TOP 10.
- **Named instance**: `MSSQL_INSTANCE=SQLEXPRESS` (host in `MSSQL_SERVER`) — the
  adapter uses instanceName (SQL Browser) and ignores `MSSQL_PORT`. If the
  instance is on a static port, leave `MSSQL_INSTANCE` blank and set the port.
- Test connectivity without touching the app: `node scripts/check-mssql.js`.

### PostgreSQL (legacy alternative) — `queries.js` `postgres`
`maps_job` ⟕ `maps_customer`/`maps_product` ⟕ `jtc_maps_jp` (history table →
`ORDER BY … LIMIT 1` picks latest). Matches ordernumber or barcode id.

---

## 9. Print queue — `server/printQueue.js` (+ `spooler.js`)

The operator-facing queue. Persisted to `print-jobs.json` (gitignored); survives
restarts and power cuts.

**Job lifecycle:** `queued → printing → done` (or `error` for a bad JTC).
`printing` means "handed to the Windows spooler," not "physically printed."

**Worker (one job at a time, only when not paused):**
1. Render TSPL; a data error (unknown JTC / bad template) → `error`, **skip**
   (does not pause the run).
2. Readiness check via `agent.printerStatus` (agent reachable / not offline).
3. Send to the agent, poll `/print/status` until `SUCCESS`/`FAILED`.
4. **Verify it drained** — poll `queueDepth` until 0. The agent's SUCCESS only
   means the label reached the Windows spooler; a healthy printer drains it to 0,
   a dead one doesn't.

**On any printer/comms failure → pause** (never silently drop). The stuck label
is **pulled back out of the Windows spooler** (`spooler.clear` → PowerShell
`Remove-PrintJob`, local-agent only) and re-queued, so it will **not auto-print
when the printer wakes** — nothing prints until the operator clicks **Resume**.
Resume then drains the whole backlog in order.

**Startup:** loads the persisted queue; starts **paused if there's a backlog**
(so a power-cut restart waits for a human), **running if empty** (so the first
scan of the day prints hands-free).

**UI (queue panel):** shows `#`print-order, JTC No (+ a `↳ from <welding JTC>`
provenance line when the label was resolved welding→painting, §17), the **label
type** (tab name), and status; a red paused banner with the reason + next job;
**Resume / Pause / Clear done / Clear queue**. `clearFinished()` ("Clear done")
drops finished history only; `clearAll()` ("Clear queue", confirm-gated) discards
the **whole backlog** incl. pending and un-pauses — for when the operator does not
want to continue. Wording is honest: **"Sent to printer"** (not "Printed"), because
media-out is invisible to Windows (see §12).

**Endpoints:** `GET /api/queue`, `POST /api/queue/{pause|resume|remove|clear|clear-all}`.
Tunable: `QUEUE_DRAIN_TIMEOUT_MS` (default 12000), `QUEUE_DRAIN_POLL_MS`.

---

## 10. Destinations ("tabs") — `locations.json` + `server/locations.js`

One universal file lists every printer/label combo; the **same file deploys to
every terminal**, and each operator picks their tab (remembered in `localStorage`).
A tab bundles everything that differs per job:

```json
{ "id":"fg-sticker-qc", "name":"P1 FG Sticker (QC)", "templateId":"12",
  "variant":"qc", "barcodeNudge":16 }
```
Optional per-tab overrides: `agentUrl` (default `AGENT_URL`, i.e. the local
printer — set an address only for a tab that drives another machine's printer),
`printerType`. Only `id` + `name` are required; the rest fall back to `.env`.
With no `locations.json`, a single default tab is synthesized from `.env`.

Current tabs: **FG Sticker (QC)** → tpl 12, **FG Sticker (Plain)** → tpl 11,
**Work Order (P3) — K2VG** → tpl 13 (`models:["K2VG"]`), **Work Order (P3) — K0WY**
→ tpl 16 (`models:["K0WY"]`). `GET /api/locations` feeds the tab bar (agentUrl is
kept server-side). Every print/preview/model/status/reload call carries
`?location=<id>` (or in the POST body); the server resolves it to the tab.

Extra per-tab options added 2026-07: `upright:false` (print vertically, as MES
designed, instead of the default upright rotation — used by the P3 tabs);
`models:[…]` (SubProductGroup names this tab auto-prints — see §16).

---

## 11. HTTP API (this app, port 3000)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | `{companyName, defaultUom}` |
| GET | `/api/locations` | Tab list `[{id,name,templateId,variant}]` |
| GET | `/api/jtc/search?q=` | Suggestions `[{jtcNo, partName}]` |
| GET | `/api/jtc?no=` | Full record for one JTC (query param — JTC Nos contain `/`, spaces) |
| GET | `/api/label/model?no=&location=` | Geometry for the SVG preview |
| GET | `/api/print/preview?no=&location=` | Rendered TSPL text (no printing) |
| POST | `/api/print` `{jtcNo, location}` | **Enqueue** a print → `{queued, id}` |
| GET | `/api/queue` | Queue snapshot `{paused, jobs[]}` (jobs carry `sourceJtc`) |
| POST | `/api/queue/pause` \| `/resume` \| `/remove` \| `/clear` \| `/clear-all` | Queue control (`clear`=finished only, `clear-all`=whole backlog) |
| GET | `/api/print/status/:jobId?location=` | Agent job status (passthrough) |
| GET | `/api/printer/status?location=` | Agent/printer health (passthrough) |
| POST | `/api/template/reload` `{location}` | Force-refetch that tab's MES template |
| GET | `/api/auto` | Auto-print watcher status (badge + diagnostics) |
| POST | `/api/auto/test` `{jtcNo, location?}` | Route+enqueue a **real** JTC, no DB write (safe test) |
| POST | `/api/dev/complete` \| `/reset` `{jtcNo\|id}` | Flip a **mock** job's ActualEndDate (mock-only, 403 otherwise) |

---

## 12. Key decisions & gotchas (hard-won — don't re-learn)

- **We render TSPL ourselves;** the MES render endpoint only produces sample data.
- **Field keys are fixed + exact.** The MES catalog is a closed list — you cannot
  invent `jtcNumber`/`coNo`/`customer` keys in the designer. To add a label field
  you must (a) have the MES add the key to its catalog, (b) bind the element to
  it, and (c) have `mapRecordToFields` return that exact key. Values for
  `customer/partNo/model/customerOrder` are already fetched; they print blank only
  because the MES has no bound keys for them yet.
- **The field-key names read "backwards" in places** because the templates were
  pre-bound. Follow the comments in `mapRecord.js`/`queries.js`.
- **Media-out is invisible to software.** When the TE244 runs out mid-print,
  Windows still drains the spooler and reports the printer Normal/Idle
  (`DetectedErrorState 0`, `hasError false`). So the queue cannot auto-detect
  out-of-labels — it shows **"Sent to printer"** and relies on the operator
  seeing the red light + the printer's own buffer (it reprints held jobs on feed).
- **The agent's `online` flag is unreliable** (`-not $printer.Offline` is always
  true for a USB printer, even unplugged). The queue keys off **`queueDepth`
  draining** instead, which *is* reliable for "off/unplugged" (spooler holds).
- **`copy` to the Windows share succeeds even with no printer** — the spooler
  accepts the bytes. Hence the drain check, not the send result, is the signal.
- **One print-agent per terminal.** Duplicate processes with the same `agentId`
  cause a relay connect/disconnect flap and break printing.
- **Barcode** encodes `*j` + `Job.Id`; skipped if none; centered under a QC box
  only when a "QC CHOP" caption is present; printed position tuned per-tab.
- **Byte-match** with the MES renderer for text/bar/box; barcode line diverges.

---

## 13. Configuration (`.env` + `locations.json`)

`.env` (per-terminal, gitignored) holds **global defaults + secrets**; per-tab
values live in `locations.json`.

| Var | Meaning |
|---|---|
| `DB_CLIENT` | `mssql` (active) \| `postgres` \| `mock` |
| `PORT` | Web server port (3000) |
| `MSSQL_SERVER/INSTANCE/PORT/DATABASE/USER/PASSWORD/ENCRYPT/TRUST_SERVER_CERT` | SQL Server conn |
| `PG_*` | Postgres conn (legacy) |
| `MES_BASE_URL` | MES base (`…:8081`) |
| `LABEL_TEMPLATE_ID` | Default template when a tab omits `templateId` |
| `TEMPLATE_TTL_MS` | Template cache lifetime (default 5 min) |
| `AGENT_URL` | Default print-agent (`http://localhost:9000`) |
| `PRINTER_TYPE` | Default `tsc` \| `hprt` |
| `LABEL_VARIANT` | Default `qc` \| `plain` when a tab omits `variant` |
| `BARCODE_NUDGE_DOTS` | Default barcode calibration when a tab omits `barcodeNudge` |
| `QUEUE_DRAIN_TIMEOUT_MS` / `QUEUE_DRAIN_POLL_MS` | Spooler-drain verification timing |

---

## 14. Running

```bash
npm install
npm start           # -> http://localhost:3000
```
- Physical printing needs the **print-agent** running on the terminal (:9000) and
  the TE244 reachable (USB share `TSC_TE244`).
- `DB_CLIENT=mock` runs with no DB.

**What reloads how:**
- **`.js` changes** → **restart the app** (Node caches modules). One server per port.
- **`locations.json`** → read live (no restart); the tab bar updates on next poll.
- **MES template edits** → **Reload template** button, or wait ≤ TTL, or restart.
- **`BARCODE_NUDGE_DOTS`** → read live per print.

---

## 15. Common extension tasks

- **Finish C/O No:** MES adds a catalog key for it → bind the "C/O No" element →
  rename the `customerOrder` LEFT key in `mapRecord.js` to that key (value side is
  already `r.coNo`).
- **Add a destination:** add an object to `locations.json` (`id`, `name`,
  `templateId`, `variant`, `barcodeNudge`; optional `agentUrl`). No restart.
- **Add a label field:** MES catalog key + designer binding + `mapRecordToFields`
  returns that key (+ `queries.js` `getOne` selects the column `AS alias` if new).
- **Tune Stock/Process code:** the FlowType assumptions in `queries.js` `mssql.getOne`.
- **Switch DB engine:** `DB_CLIENT` + the matching conn block + SQL in `queries.js`.
- **Calibrate print:** per-tab `barcodeNudge` in `locations.json` (live).
- **New element type:** add a case in `render.js` `renderElement` **and**
  `model.js`/`labelPreview.js` `drawElement`.

---

## 16. Auto-print watcher — `server/autoPrint.js` (SHIPPED)

Replaces scanning for normal flow: the server **polls the DB for jobs that just
completed** and auto-enqueues their labels, hands-free. Manual lookup stays as a
reprint/fallback. Runs **server-side** — no browser needed (see §18).

- **Trigger = `Job.ActualEndDate` NULL → set.** Detected as an **edge, not a
  level**: a persisted **watermark** (newest `ActualEndDate` acted past) means only
  *new* completions fire; a persisted **printed-set** of `Job.Id`s guarantees one
  label per job even across restarts/row-edits. State in `auto-print-state.json`
  (gitignored). **First run seeds the watermark from the DB's newest completion**
  → history is ignored. **Downtime = catch-up** (persisted watermark resumes);
  delete the state file to re-seed at "now" and skip a backlog.
- **Routing = model → location.** A completed job's `model` (SubProductGroup.Name)
  matches a location's `models:[…]` list. **This station only prints locations
  named in `.env` `AUTO_PRINT_LOCATIONS`**, so no two stations double-print.
- **Config (`.env`, per-station):** `AUTO_PRINT_ENABLED` (default false),
  `AUTO_PRINT_LOCATIONS` (comma list of tab ids this station serves),
  `AUTO_PRINT_POLL_MS` (default 15000).
- **DB:** `queries.js` `getCompletedSince(since)` (rows completed after the
  watermark, oldest-first) + `getLatestCompletionMark()` (seed). Both on
  mssql/postgres/mock adapters.
- **Enqueues through the existing print queue** (§9), inheriting all its
  resilience. Timezone-safe (watermark round-trips as the DB's own value).
- **UI:** green **Auto-print: watching … · checked hh:mm:ss** badge in the queue
  panel (red on poll error). `GET /api/auto` = status.
- **Test endpoints:** `POST /api/auto/test {jtcNo, location?}` routes+enqueues a
  **real** JTC with no DB write (safe against prod). `POST /api/dev/{complete|reset}`
  flips a **mock** job's `ActualEndDate` to exercise the full detect loop —
  **hard-guarded to `DB_CLIENT=mock`** (403 otherwise).

---

## 17. Welding → Painting WO auto-print (BUILT — phase 1)

When a **Welding Line JTC** finishes its Leak Test, the K2VG station **auto-prints**
(and manual/scan lookups **preview + print**) the **Painting Line JTC's** Work Order
label — a *different, linked* job that then rides the WIP trolley into the painting
line (ShotBlast → Painting). This **replaces** printing the welding job's own label.

**The two jobs** (verified against real rows 33721↔33015, 33722↔33016; both share `MOId`):
| | Welding JTC | Painting JTC |
|---|---|---|
| OrderNumber | has ` / <partNo>` suffix (`…(40/40)  / E23-0100-WF`) | no suffix (`…(40/40)`) |
| Stock code | has `-WF` (`E23-0100-WF`) | no `-WF` (`E23-0100`) |
| ProcessCode | **`L-T` or `LKT`** (Leak Test) | **`PL`** (Painting, ProcessCodeId 38) |
| `ParentJob` | → the **Painting** job's `Id` | null |

**Trigger / resolution (implemented):**
1. A job completes (`ActualEndDate` set — §16's watermark), **or** an operator
   enters/scans a JTC on a `weldingToPainting` tab.
2. Filter: `processCode` ∈ {`L-T`, `LKT`} (both mean **Leak Test**; `L-T` is
   actually the more common — match **both**) **and** the tab is `weldingToPainting`.
   ⚠ **`ParentJob`-presence is NOT the filter** — it's a general job hierarchy;
   cutting/bending/welding sub-jobs all have parents. Leak-Test processCode is the
   decision; `ParentJob` is used only for the *lookup*.
3. Follow the welding job's **`ParentJob`** → the Painting job.
4. Print/preview the **Painting JTC's** WO label (template 13 / `work-order-p3-k2vg`),
   data from the Painting `Job` record.
5. **Dedup (auto) by the welding `Job.Id`.**

**Provenance everywhere:** the preview shows a note *"Showing Painting Line label …
— from Welding JTC …"*, and the print queue shows *"↳ from &lt;welding JTC&gt;"* under
the job — for manual, scan, and auto paths alike. Entering the Painting JTC
directly (or any non-Leak-Test job) shows it as-is with no provenance.

**Code (as built):**
- `server/paintingFlow.js` (new): `isLeakTest()` (token-matches L-T/LKT) +
  `resolvePainting(record, loc, db)` → `{ record, sourceJtc }` (follows `ParentJob`
  via `getOne`, which resolves by `Job.Id`).
- `queries.js`: `parentJobId` in the shared `COLS`; `parentJtcNo` (self-join on
  `ParentJob`) in `getCompletedSince`.
- `locations.js` / `locations.json`: per-tab **`weldingToPainting:true`** (set only
  on `work-order-p3-k2vg`). Other tabs print the entered/completed job directly.
- `autoPrint.js`: `resolveTarget()` uses `isLeakTest` + `parentJtcNo`; passes the
  welding JTC as `sourceJtc` to the queue.
- `index.js`: `/api/label/model`, `/api/print/preview`, `/api/print` all resolve
  welding→painting; the model + print responses carry `sourceJtc` / `printJtc`.
- `printQueue.js`: `add(jtcNo, location, sourceJtc)` stores it; `list()` exposes it.
- Front-end: `labelPreview.js` returns the model; `app.js` shows the preview note +
  the queue "↳ from …" line; queue header/rows re-aligned (badge on its own line,
  controls wrap, rows top-align) so long JTCs + all buttons lay out cleanly.

**⚠ Process Code shows `PL` — NEXT DISCUSSION (make it `SB`?):** the painting job's
flow is a single `PL` step (ProcessCodeId 38). `SB`/ShotBlast (ProcessCodeId 46) is
the painting line's first *physical* station — **not in the painting job's flow** and
downstream of the print. To make the label's Process Code read `SB` it must be
**hardcoded** for this path (a per-location or mapRecord override); that's the next
thing to design.

### Phase 2 — QR binding + confirm-before-print (DEFERRED, blocked on QR logic)
- QR codes = **reusable engraved aluminium tags** (green=Start, red=End). We do
  **NOT** print them (thermal is monochrome; tags are physical/permanent/reusable).
- The **"Painting Line JTC Assign" module = us.** Operator provides/scans the
  green + red tag → we **record the binding** `{paintingJtc ↔ greenToken, redToken}`,
  **display both QRs in the UI** to verify, confirm all three (WO data + 2 tags) →
  **only then release the WO print** ("ONLY PRINT when all three confirmed").
- Painting line: green tag on 1st muffler (Start), red on 50th (End); CAMs scan a
  tag → resolve token→JTC via the binding → set Painting JTC `ActualStartDate`
  (1st CAM) / `ActualEndDate` (3rd CAM).
- **Open questions (user consulting others before build):** where the
  `{tag→JTC}` binding lives + how painting CAMs resolve it (existing MES table/API
  vs a table we own); how the operator hands us a tag (scan vs assign); the tag
  source/pool; the **re-bind lifecycle** (reusable, latest-wins, need enough tags
  that none is rebound while still riding a trolley); the exact "confirmed" gesture.
- Phase 1 prints the WO immediately with **no** gate; the gate is phase-2 only.

---

## 18. LeakTest embed in `BKY_eJTC` (SHIPPED)

`BKY_eJTC` (a **separate** repo at `C:\Users\User\Downloads\BKY_eJTC` — React +
Vite + MUI SPA, `ejtc-reactjs`, served over **HTTP** at e.g.
`http://43.217.35.209/leaktest?…`) embeds this app:
- `src/components/FgPrintButton.jsx` — a green **FG Print** button → MUI `<Dialog>`
  with `<iframe src="http://localhost:3000">` (the live fg-print-ui). Iframe is
  **mounted only while open** ("fresh each open"). URL override:
  `VITE_FG_PRINT_URL` (default `http://localhost:3000`).
- Wired into `src/pages/LeakTestPage.jsx` (import + one `<FgPrintButton/>` beside
  the "Downtime" button).
- **Works because** `localhost` resolves in the *operator's browser* (the print
  terminal), and both apps are HTTP → no mixed-content block. fg-print-ui runs as
  its **own process** on that terminal. **Closing the dialog stops only the
  frontend redraw** — the server-side auto-print watcher + queue keep running.

---

## 19. Other fixes (2026-07)

- **Date timezone bug fixed.** `dateIssue` is now formatted in SQL
  (`CONVERT(varchar(10), j.CreateDate, 103)` = `dd/mm/yyyy`) so a tz-less
  `datetime` can't be shifted a day by the driver reading it as UTC + local
  render. Was printing `25/06` for a `24/06 16:33` CreateDate.
- **`.btn.btn--sm` specificity fix** — the small queue buttons (Resume/Pause/Clear)
  were rendering full-size because a later single-class `.btn` won on source order.
- **Data note (not a bug):** `model` and `C/O No` are **not** mutually exclusive
  (2204 jobs have both); blank C/O = make-to-stock jobs with no `CustomerOrder`;
  the `CustomerOrderItem→CustomerOrder` join is clean (0 orphans).
