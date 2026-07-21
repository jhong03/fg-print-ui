# P1FGUI — Project Context (full technical brief)

A self-contained explanation of what this project is and how every part works.
Written so another AI/dev with no prior context can understand and extend it.

---

## 1. What it is

A minimal **local web app for production operators** at YOLLINK INDUSTRIES.
An operator picks a **JTC number** (a job) by typing or scanning it; the app pulls
that job's data from a database, shows a to-scale label preview, and prints a
**P1 FG sticker** on a **TSC TE244** thermal label printer.

The app does **not** own the label design or the printer. It plugs into an
existing factory system:
- it **reads the label layout** from an existing **MES** (a separate web system),
- it **reads the job data** from a shared **PostgreSQL** database,
- it **prints** through an existing **print-agent** that sits next to the printer.

The app's job is to be the simple operator front-end that combines those three.

---

## 2. Tech stack

- **Runtime:** Node.js (v24), CommonJS modules (`require`, not `import`).
- **Server:** Express 4.
- **Frontend:** plain HTML/CSS/JS (no framework, no build step). Served static.
- **DB driver:** `pg` (PostgreSQL). `mssql` also scaffolded but unused.
- **Barcode (preview only):** `jsbarcode`, served locally for offline use.
- **Platform:** Windows. Shell examples assume Git Bash or PowerShell.

---

## 3. The three external systems it talks to

| System | What it is | Where | What we use it for |
|---|---|---|---|
| **PostgreSQL** | Shared production DB (also used by an existing Laravel "eJTC" app) | `43.217.35.209:5432`, db `bky-ejtc` (creds in `.env`) | The **values** on the label (customer, part name, qty, etc.) |
| **MES** ("Warehouse Console P3") | A separate React web app that has a visual **label designer** + template store | `http://ec2-43-217-35-209.ap-southeast-5.compute.amazonaws.com:8081` | The **label layout** (template JSON) — positions + which field each slot wants |
| **print-agent** | A separate Node app running on each operator terminal, next to the printer | local `http://localhost:9000` (code lives at `C:\print-agent`) | We POST it **TSPL** (printer code); it drives the TSC TE244 |

> ⚠️ There is also a **local** PostgreSQL 18 on `localhost:5432` on the dev
> machine — that is a DIFFERENT database and will fail auth. The real DB is the
> **remote** host above.

### About the MES template
- Templates are JSON layouts, fetched via `GET /api/label-templates/{id}`.
- We use template **id 11** ("P1 FG Sticker"), set by `LABEL_TEMPLATE_ID`.
- A template = `{ label:{widthMm,heightMm,dpi,gapMm,direction,printMethod},
  elements:[ ... ] }`.
- Each element is `text` | `bar` | `box` | `barcode`, with `x,y` in **printer
  dots** and a `value` of either `{kind:"static", text}` (fixed wording like
  "QC CHOP", "Customer", ":") or `{kind:"field", field:"partName", prefix?}`
  (a placeholder that our code fills from the DB).
- The MES also exposes the list of valid field keys at
  `GET /api/label-templates/fields`.

### About the print-agent
- Local HTTP API on `:9000`. Key endpoint: `POST /print-label` with
  `{ printerType:"tsc", labelData:"<TSPL string>" }` → `{ success, jobId }`.
- It sends TSPL to the printer via raw TCP `:9100` (if a printer IP is set) or a
  Windows share (`TSC_TE244`).
- It also connects out to a **relay** (`ws://…:3001`) so the MES can reach it;
  our app does NOT use the relay — it talks to the agent **locally**.
- The agent must be running on the terminal for physical printing to work.

---

## 4. Directory map

```
P1FGUI/
├── .env                     Active config (gitignored; real credentials)
├── .env.example             Template for .env
├── package.json             deps: express, dotenv, jsbarcode (+ optional pg, mssql)
├── server/
│   ├── index.js             Express app: all HTTP routes, server startup
│   ├── mes.js               Fetches + caches the MES template (getTemplate, reload)
│   ├── agent.js             Client for the local print-agent (:9000)
│   ├── db/
│   │   ├── index.js         Adapter factory — picks by DB_CLIENT env
│   │   ├── queries.js       *** THE SQL *** (postgres + mssql query strings)
│   │   ├── postgres.js      pg adapter (search, getOne, close)
│   │   ├── mssql.js         SQL Server adapter (scaffolded, unused)
│   │   └── mock.js          In-memory sample data (DB_CLIENT=mock)
│   └── label/
│       ├── render.js        Template + values -> TSPL string (renderTspl)
│       ├── model.js         Template + values -> geometry for on-screen preview
│       ├── mapRecord.js     DB record -> MES field-key/value map
│       ├── textLayout.js    Wraps long text values onto extra lines
│       └── barcodeLayout.js Skip-if-empty + center barcode under QC box
├── public/
│   ├── index.html           The single screen
│   ├── styles.css           Minimal styling + print CSS
│   ├── app.js               Search/scan/select/print/preview UI logic
│   └── labelPreview.js      Draws the to-scale SVG label from the model
├── README.md
├── FLOW.md                  Plain-language operator + full flow + reload branch
└── PROJECT_CONTEXT.md       (this file)
```

---

## 5. The core idea (read this to understand everything)

**Three inputs combine into one printed label:**

```
MES template (layout + field keys)  +  DB record (the values)  →  our code  →  TSPL  →  printer
```

- **MES** decides *which rows exist, where they sit, and which key each wants.*
  It carries **no data**.
- **DB** provides the **actual values**.
- **Our code** (`render.js`) is a re-implementation of the MES's own TSPL
  renderer. We generate the TSPL ourselves because the MES's render endpoint only
  injects sample data — it can't use real job data. Owning TSPL generation is
  what lets us add wrapping, barcode centering, and print calibration.

**Field matching is an exact, case-sensitive key lookup.** A template element
`{value:{kind:"field", field:"partName"}}` is filled by `values["partName"]`,
where `values` is built by `mapRecordToFields()`. If the key doesn't match a
property in that object, the slot prints blank. (See `render.js` `resolveValue`.)

---

## 6. Data + print flow (end to end)

**Look up a job**
1. Operator types/scans → `GET /api/jtc/search?q=…` → `db.search()` → Postgres →
   suggestions dropdown.
2. Operator selects one → `GET /api/jtc?no=…` → `db.getOne()` → the full record →
   shown on screen (the SVG preview).

**Preview** (to-scale, matches the print)
- `GET /api/label/model?no=…` → `getTemplate()` (MES) + `buildModel()` →
  JSON of the label's dimensions + positioned, value-resolved elements →
  `public/labelPreview.js` draws it as an SVG.
- `GET /api/print/preview?no=…` → the exact **TSPL** text (no printing).

**Print**
- `POST /api/print { jtcNo }` → `db.getOne()` + `getTemplate()` +
  `mapRecordToFields()` + `renderTspl()` → TSPL → `agent.printLabel()` →
  `POST http://localhost:9000/print-label` → agent → **TSC TE244**.

---

## 7. The label rendering pipeline (detail)

### 7.1 Field mapping — `server/label/mapRecord.js`
`mapRecordToFields(record)` turns the DB row into a flat `{ fieldKey: value }`
map keyed by **MES field-key names**:
- `coNumber` ← `jtcNo` (the JTC No / `ordernumber`)
- `woNumber` ← `woNo`
- `partName` ← `partName`
- `dateIssue` ← `date` (formatted `dd/mm/yyyy`)
- `qty` ← `qty`
- `jtc_barcodeId` ← `barcodeId` (empty string if the job has none)
- `customer`, `partNo`, `model` ← from DB, **ready but not yet used** (the MES
  template has no slots bound to these keys yet)
- `stockCode`, `processCode`, `empNo`, `remarksLine1-4`, `weightLine1-4`,
  `binId`, `lotNumber` ← emitted empty (no data source yet)

### 7.2 TSPL rendering — `server/label/render.js`
`renderTspl(template, values, opts)`:
- Emits the header (`SIZE/GAP/DIRECTION/CLS/[SET PRINTMETHOD]/OFFSET`).
- Walks `template.elements` in order; per type emits TSPL:
  - `text` → `TEXT x,y,"font",rotation,xMul,yMul,"value"` (value from
    `resolveValue`, may wrap into several lines — see 7.4).
  - `bar` → `BAR x,y,w,h`
  - `box` → `BOX x,y,x+w,y+h,thickness`
  - `barcode` → `BARCODE …` (see 7.5) — skipped entirely if no id.
- Ends with `PRINT 1,1\n`.
- **Verified byte-for-byte identical to the MES's own renderer** for text/bar/box
  (the barcode line intentionally differs).

### 7.3 Preview model — `server/label/model.js`
`buildModel(template, record)` uses the same `resolveValue`, `layoutText`, and
`barcodeLayout` logic, but returns **geometry** (dots) instead of TSPL, so the
browser can draw an SVG that matches the print. Output:
`{ label:{widthMm,heightMm,dpi,widthDots,heightDots}, elements:[…] }`.

### 7.4 Text wrapping — `server/label/textLayout.js`
Long values (esp. a JTC No with a component suffix) would overrun into the
barcode/QC box. `layoutText()` measures how far the text can extend before
hitting an obstacle (bar/box/barcode in the same lane) or the label edge, and
wraps at word boundaries onto stacked lines. Used by BOTH print and preview.

### 7.5 Barcode standardization — `server/label/barcodeLayout.js`
- **Skip when empty:** if `jtc_barcodeId` is blank, no barcode is drawn (avoids a
  fallback that produced inconsistent widths).
- **Center under the QC box:** Code128 width ∝ content length, so we estimate the
  width and offset the anchor so the barcode's center aligns with the QC CHOP
  box's center. Robust to the box being moved in the template.
- **Print calibration:** `BARCODE_NUDGE_DOTS` (from `.env`, read live) shifts the
  **printed** barcode horizontally (positive = right; 8 dots ≈ 1 mm) to correct
  small physical off-centering. Does NOT affect the preview.

### 7.6 Coordinate system (important for the preview)
- Printer dots at **203 dpi** = **8 dots/mm**. Label 80×125 mm ≈ **640×1000 dots**,
  portrait. Text is drawn at **rotation 270** in the template.
- The label is READ in landscape. The preview maps native → display via
  `(x, y) → (heightDots − y, x)`, implemented as the SVG group transform
  `translate(heightDots,0) rotate(90)`. Text keeps its own `rotate(270)`, so
  270 + 90 = 360 → it reads horizontally.

---

## 8. Database layer

- **Swappable** via `DB_CLIENT` = `mock` | `mssql` | `postgres`. `server/db/index.js`
  is the only switch; every adapter exposes the same interface:
  `search(term) -> [{jtcNo, partName}]`, `getOne(no) -> record | null`, `close()`.
- **Currently `postgres`.** The real SQL lives in `server/db/queries.js`.
- The `getOne` record shape the rest of the app expects:
  `{ jtcNo, customer, partName, partNo, model, date, qty, woNo, barcodeId }`.
- **Real-data quirks handled in the SQL/app:**
  - `ordernumber` (the JTC No) contains **spaces, trailing spaces, batch suffixes
    like `(33/46)`, and slashes** → lookup uses a **query param** (`?no=`, not a
    path param), matches with `btrim(...)`, and also matches by `jtc_barcodeId`
    so scanning the printed barcode resolves the job.
  - The join to `jtc_maps_jp` duplicates rows → `search` uses `GROUP BY` to dedupe.
  - No UOM column → the label's "PCS" is static template text; `DEFAULT_UOM`
    exists as a fallback for any future use.

Tables involved (Postgres): `public.maps_job j` (jobs; `ordernumber`, `quantity`,
`actualenddate`, `customerid`, `productid`), `public.maps_customer` (`name`),
`public.maps_product` (`name`, `partnumber`), `public.jtc_maps_jp jp` (joined on
`jp."jtc_orderNumber" = j.ordernumber`; has `jtc_WO`, `jtc_PartNumber`,
`jtc_barcodeId`).

---

## 9. HTTP API (this app, port 3000)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` , `/vendor/JsBarcode.all.min.js` | Static page + local barcode lib |
| GET | `/api/config` | `{companyName, defaultUom}` |
| GET | `/api/jtc/search?q=` | Suggestions `[{jtcNo, partName}]` (Postgres) |
| GET | `/api/jtc?no=` | Full record for one JTC (Postgres) |
| GET | `/api/label/model?no=` | Resolved geometry for the SVG preview |
| GET | `/api/print/preview?no=` | The rendered TSPL text (no printing) |
| POST | `/api/print` `{jtcNo}` | Render + send to print-agent → `{jobId}` |
| GET | `/api/print/status/:jobId` | Agent job status (passthrough) |
| GET | `/api/printer/status` | Agent/printer health (passthrough) |
| POST | `/api/template/reload` | Force-refetch the MES template (clears cache) |

**Upstream calls this app makes:** Postgres (via `pg`); MES
`GET /api/label-templates/{LABEL_TEMPLATE_ID}`; agent `POST /print-label`,
`GET /print/status/:jobId`, `GET /printer/status`.

---

## 10. Configuration (`.env`)

| Var | Meaning |
|---|---|
| `DB_CLIENT` | `postgres` (active) \| `mssql` \| `mock` |
| `PORT` | Web server port (3000) |
| `COMPANY_NAME`, `DEFAULT_UOM` | Minor UI/fallback values |
| `PG_HOST/PORT/DATABASE/USER/PASSWORD/SSL` | Postgres connection (remote) |
| `MSSQL_*` | SQL Server connection (unused unless DB_CLIENT=mssql) |
| `MES_BASE_URL` | MES base (`…:8081`) — where templates are fetched |
| `LABEL_TEMPLATE_ID` | Which template to use (`11` = P1 FG Sticker) |
| `TEMPLATE_TTL_MS` | Template cache lifetime (default 5 min) |
| `AGENT_URL` | Local print-agent (`http://localhost:9000`) |
| `PRINTER_TYPE` | `tsc` \| `hprt` |
| `BARCODE_NUDGE_DOTS` | Print-only barcode horizontal calibration (read live) |

---

## 11. Running it

```bash
npm install
npm start           # -> http://localhost:3000
```
- Physical printing requires the **print-agent** running on the terminal (:9000)
  and the TSC TE244 reachable.
- Runs on **mock** data with no DB (`DB_CLIENT=mock`).

**What reloads how:**
- **Code changes (`.js`)** → require a **server restart** (Node caches modules).
  Ensure only ONE server on port 3000 (a second silently fails to bind).
- **MES template changes** → click **Reload template** in the UI, or restart.
- **`BARCODE_NUDGE_DOTS`** → read live from `.env` on each print (no restart).

---

## 12. Key decisions & gotchas (so you don't re-learn them)

- **We render TSPL ourselves;** the MES render endpoint only produces sample data.
- **Field keys are exact, case-sensitive.** To add a label field: the MES template
  must bind a slot to a key, and `mapRecordToFields` must return that same key.
- **Customer / Part No / Model print blank** today: our DB has the values
  (`customer`, `partNo`, `model` are already in `mapRecordToFields`), but the MES
  template has no slots bound to them AND the MES field catalog doesn't list them
  yet. Once the MES adds those fields, match the key spelling in `mapRecord.js`.
- **All fixed wording** (company name, "Customer", "QC CHOP", colons, "PCS") are
  **static text in the MES template**, not in our code.
- **Barcode** encodes `*j` + `jtc_barcodeId`; skipped if none; centered under the
  QC box; print position fine-tuned with `BARCODE_NUDGE_DOTS`.
- **Byte-match:** our TSPL equals the MES renderer for text/bar/box; the barcode
  line intentionally diverges.
- **The remote Postgres is the real one;** localhost:5432 on the dev box is a
  different, unrelated database.

---

## 13. Common extension tasks

- **Add a new field to the label:** (1) MES designer adds a slot bound to a key;
  (2) ensure `mapRecordToFields` returns that key from the DB record; (3) if the
  DB column is new, add it to `queries.js` `getOne` with the right `AS "alias"`.
- **Change how many search results show:** `LIMIT` in `queries.js` `postgres.search`.
- **Point at a different template:** `LABEL_TEMPLATE_ID` in `.env`.
- **Switch DB engine:** change `DB_CLIENT` + fill the matching connection block +
  put real SQL in `queries.js`. Adapters already share one interface.
- **Move the barcode / calibrate print:** `BARCODE_NUDGE_DOTS` (live) or the
  centering logic in `barcodeLayout.js`.
- **Support a new template element type:** add a case in `render.js`
  `renderElement` and in `model.js` + `labelPreview.js` `drawElement`.
