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
Turns the DB row into `{ MES-field-key: value }`. **Current mapping:**
- `coNumber` ← `jtcNo` — the **JTC No** (Job.OrderNumber). *(The template's "JTC
  No" element binds `coNumber`.)*
- `customerOrder` ← `r.coNo` — the **C/O No** (CustomerOrder.OrderNumber).
  ⚠ **Work in progress**: the value side is wired (query returns `coNo`), but
  `customerOrder` is a **placeholder LEFT key** — the MES field catalog has no
  key for it yet. To finish: create/choose the real MES key, rename the LEFT key
  here to match, and bind the "C/O No" element to it in the designer.
- `partName`, `dateIssue` (`dd/mm/yyyy`), `qty`, `jtc_barcodeId` (blank ⇒ barcode
  skipped) — bound and working.
- `customer`, `partNo`, `model` — value side wired (query returns them), but the
  MES catalog has **no keys** for them yet → print blank until the MES adds them.
- `stockCode`, `processCode`, `empNo` — Work Order fields (SQL Server; §8).
- `woNumber`, `binId`, `lotNumber`, `remarksLine1-4`, `weightLine1-4` — emitted
  empty (no live source).

> **Naming gotcha:** the field-key names don't always match their meaning,
> because the MES designer's catalog is fixed and the templates were bound before
> our involvement. Trust the mapRecord comments, not the key names.

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

**UI (queue panel):** shows `#`print-order, JTC No, the **label type** (tab name),
and status; a red paused banner with the reason + next job; **Resume / Pause /
Clear done**. Wording is honest: **"Sent to printer"** (not "Printed"), because
media-out is invisible to Windows (see §12).

**Endpoints:** `GET /api/queue`, `POST /api/queue/{pause|resume|remove|clear}`.
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
**Work Order (P3)** → tpl 13. `GET /api/locations` feeds the tab bar (agentUrl is
kept server-side). Every print/preview/model/status/reload call carries
`?location=<id>` (or in the POST body); the server resolves it to the tab.

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
| GET | `/api/queue` | Queue snapshot `{paused, jobs[]}` |
| POST | `/api/queue/pause` \| `/resume` \| `/remove` \| `/clear` | Queue control |
| GET | `/api/print/status/:jobId?location=` | Agent job status (passthrough) |
| GET | `/api/printer/status?location=` | Agent/printer health (passthrough) |
| POST | `/api/template/reload` `{location}` | Force-refetch that tab's MES template |

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
