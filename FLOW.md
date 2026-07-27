# JTC Operator UI — Flow Guide

Four parts: **operator steps**, the **full flow**, the **print queue** (how prints
are held/retried), and the **reload-template mechanism**.

---

## 1. Simple operator instructions

1. **Open** the app: `http://localhost:3000`
2. **Pick the destination tab** (e.g. *P1 FG Sticker (QC)*, *(Plain)*, *Work Order
   (P3)*). Your choice is remembered on this terminal.
3. **Pick the job:**
   - **Scan** the JTC barcode (or paste it) → it loads **and queues to print
     automatically**, hands-free.
   - **Type** it → matches appear; press Enter / tap one to load, then click
     **Print label** to queue it.
4. **Watch the Print queue** at the bottom: each job shows its `#`order, JTC No,
   label type, and status. **"Sent to printer"** = handed to the printer —
   confirm the label physically came out.
5. If the queue says **Paused** (printer offline / not ready): fix the printer
   (reload labels/ribbon, power on), then click **Resume**. Queued jobs print in
   order.

*Optional:* **Preview TSPL** shows the exact printer code. **Reload template**
pulls the latest design from MES (see §4). **Clear** resets the input.

---

## 2. Full flow

**Look up:** type/scan → `GET /api/jtc/search` (SQL Server) → select/scan →
`GET /api/jtc?no=` → record → on-screen SVG preview (`/api/label/model`).

**Print:** `POST /api/print {jtcNo, location}` **enqueues**. The queue worker maps
the record to MES field keys → renders TSPL → `POST :9000/print-label` to that
tab's print-agent → TE244. Scans enqueue automatically; typed lookups enqueue on
the **Print label** click.

**Preview (no print):** `GET /api/print/preview?no=&location=` → same map+render →
TSPL text.

**Who runs where**

| Piece | Where | Port |
| --- | --- | --- |
| Operator UI (this app) | operator terminal | 3000 |
| print-agent | same terminal | 9000 |
| MES (templates) | EC2 | 8081 |
| SQL Server (job data) | `10.0.100.14\SQLEXPRESS` | (instance) |
| TSC TE244 | USB share `TSC_TE244` on the terminal | — |

**Field mapping** (record → MES field key): `jtcNo→coNumber` (JTC No),
`coNo→customerOrder` (C/O No — *placeholder key, pending MES field + binding*),
`partName→partName`, `date→dateIssue`, `qty→qty`, `barcodeId(Job.Id)→jtc_barcodeId`.
`customer/partNo/model` are fetched but print blank until the MES adds bindable
keys. `stockCode/processCode/empNo` are for the Work Order template.

---

## 3. Print queue (hold / retry / resume)

Prints go through a **persistent queue** (`server/printQueue.js`, saved to
`print-jobs.json`), not straight to the printer.

- **Hands-free on scan; one at a time.** Each job is sent, then **verified**: the
  agent only confirms the label reached the Windows spooler, so the queue watches
  the spooler **drain to empty** to know it actually printed.
- **Pauses on trouble** (printer offline, agent unreachable, spooler not draining)
  — never silently drops a job. On pause it **pulls the stuck label back out of
  the spooler** so it won't auto-print when the printer wakes; **nothing prints
  until Resume**, then the backlog drains in order.
- **Survives power cuts.** On restart it reloads the queue and starts **paused if
  there's a backlog** (waits for a human), or running if empty.
- **Data errors** (unknown JTC) mark that one job `error` and are skipped — they
  don't pause the line.
- **Limitation:** out-of-labels mid-print is invisible to Windows, so the queue
  can't auto-detect it — it shows "Sent to printer"; the operator watches the
  printer (which also reprints held jobs on feed after reloading).

Endpoints: `GET /api/queue`, `POST /api/queue/{pause|resume|remove|clear}`.

---

## 4. Reload-template mechanism

The label **design** is fetched from MES (`templateId` per tab; cached per id for
`TEMPLATE_TTL_MS`, default 5 min). Print & Preview call `getTemplate(templateId)`.

- **Automatic:** cache younger than TTL → use it; else fetch fresh; if the fetch
  fails but a cached copy exists → use the cached copy.
- **Manual (Reload template button):** `POST /api/template/reload {location}` →
  force a fresh fetch for that tab's template; on success re-render the open TSPL
  preview.

**For a MES edit to show:** keep the same `templateId` the tab points at, and use
only supported element types (`text/bar/box/barcode`). New element *types* are
skipped until we add support.

---

## Config that controls this

Global defaults + secrets in `.env`; per-tab template/variant/calibration in
`locations.json`.

| Where | Key | Purpose |
| --- | --- | --- |
| `.env` | `MES_BASE_URL` | Where to fetch templates |
| `.env` | `LABEL_TEMPLATE_ID` | Default template if a tab omits it |
| `.env` | `TEMPLATE_TTL_MS` | Auto-refresh window (ms) |
| `.env` | `AGENT_URL` / `PRINTER_TYPE` | Default print-agent + type |
| `.env` | `DB_CLIENT` + `MSSQL_*` | Active DB (SQL Server) |
| `locations.json` | `templateId` / `variant` / `barcodeNudge` / `agentUrl` | Per-tab overrides |
