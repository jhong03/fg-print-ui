# JTC Operator UI

A minimal local web app for production operators: pick a **JTC No** (type or scan),
see the job's details, and print the label.

Runs on mock data out of the box. Swap in your real SQL Server (or PostgreSQL)
by editing two files — no code changes needed elsewhere.

---

## Run it now (mock data)

```bash
npm install
npm start
```

Open **http://localhost:3000**. Try searching `J26` — three sample jobs are built in.

---

## Wire up the real database

Everything you touch lives in two places:

1. **`.env`** — connection details. Copy the template and edit:
   ```bash
   cp .env.example .env
   ```
   Set `DB_CLIENT=mssql` (or `postgres`) and fill in the matching connection block.

2. **`server/db/queries.js`** — the actual SQL. Replace `YOUR_TABLE` and the
   column names with your schema. The comments at the top of that file list the
   exact output columns the app expects (and how to alias them).

Then install the driver for your engine:

```bash
npm i mssql      # for SQL Server
# or
npm i pg         # for PostgreSQL
```

Restart (`npm start`). That's it — moving from SQL Server to PostgreSQL later is
just a change of `DB_CLIENT` plus the `postgres` section of `queries.js`.

---

## How the pieces fit

```
server/
  index.js          Express server + API endpoints
  db/
    index.js        Picks the adapter from DB_CLIENT (the only switch)
    queries.js      <-- YOUR SQL goes here
    mssql.js        SQL Server adapter (placeholder, ready to use)
    postgres.js     PostgreSQL adapter (placeholder, ready to use)
    mock.js         Sample data so the UI runs with no database
  mes.js            Fetches the label template from the MES (cached)
  agent.js          Client for the local print-agent (:9000)
  label/
    render.js       Template JSON -> TSPL (byte-matches the MES renderer)
    mapRecord.js    JTC record -> MES label field values
public/
  index.html        The screen
  styles.css        Minimal styling + print layout
  app.js            Search / scan / load / print logic
```

### API

| Method | Path                        | Purpose                                  |
| ------ | --------------------------- | ---------------------------------------- |
| GET    | `/api/jtc/search?q=...`     | Suggestions list (`jtcNo`, `partName`)   |
| GET    | `/api/jtc?no=...`           | Full record for one JTC number           |
| GET    | `/api/config`               | UI config (company name, default UOM)    |
| POST   | `/api/print` `{jtcNo}`      | Render label + send to the print-agent   |
| GET    | `/api/print/preview?no=...` | The rendered TSPL (no printing)          |
| GET    | `/api/print/status/:jobId`  | Print-job status (agent passthrough)     |
| GET    | `/api/printer/status`       | Printer health (agent passthrough)       |

The full record must contain:
`jtcNo, customer, partName, partNo, model, date, qty, uom, woNo, barcodeId`.

---

## Notes

- **Barcode scanners** work as-is: a scanner types the code and presses Enter,
  which loads that JTC directly. Typing a few characters shows live suggestions.
- **Printing** goes through the existing MES pipeline, not the browser:
  1. The server fetches the label template from the MES (`LABEL_TEMPLATE_ID`,
     default `11` = "P1 FG Sticker") and caches it.
  2. `label/render.js` turns that template + the JTC record into **TSPL**
     (verified byte-for-byte against the MES's own renderer).
  3. The TSPL is POSTed to the local **print-agent** (`AGENT_URL`, default
     `http://localhost:9000`), which drives the TSC printer.

  So the print-agent must be running on the operator's terminal. The on-screen
  label is a preview/confirmation only.
- **Company name** on the label comes from the MES template design.
- The web UI's own barcode preview library is served locally from
  `node_modules` — no internet needed for the page itself.
