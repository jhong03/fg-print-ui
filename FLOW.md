# JTC Operator UI — Flow Guide

Three parts: the **operator steps**, the **full flow**, and the
**reload-template mechanism** (where the label design comes from).

---

## 1. Simple operator instructions

1. **Open** the app: `http://localhost:3000`
2. **Pick the job** — type the JTC No, or scan its barcode. Matches appear as
   you type; press **Enter** or tap one to load it.
3. **Check the details** on screen (Part Name, Date, Qty, W/O No, JTC No).
4. **Print** — click **Print label**. It prints on the TSC TE244.
5. Click **Clear** for the next job.

*Optional:* **Preview TSPL** shows the exact printer code before printing.
*Optional:* **Reload template** pulls the latest label design from MES (see §3).

---

## 2. Full flow

**Look up a job:**
Operator types/scans a JTC → `GET /api/jtc/search` reads matches from Postgres →
operator selects one → `GET /api/jtc?no=...` returns the full record → details
shown on screen.

**Print a label:**
Operator clicks Print label → our server maps the JTC record to the MES field
keys → produces TSPL → `POST http://localhost:9000/print-label` to the local
print-agent → TE244 prints.

**Preview (no printing):**
Operator clicks Preview TSPL → `GET /api/print/preview?no=...` → same map +
render → returns the TSPL text.

**Who runs where**

| Piece | Where | Port |
| --- | --- | --- |
| Operator UI (this app) | operator terminal | 3000 |
| print-agent | same terminal | 9000 |
| MES (templates) | EC2 server | 8081 |
| PostgreSQL (JTC data) | remote server | 5432 |
| TSC TE244 | USB share on the terminal, or network | 9100 |

**Field mapping** (JTC record → MES label fields): `jtcNo→coNumber`,
`woNo→woNumber`, `partName→partName`, `date→dateIssue`, `qty→qty`,
`barcodeId→jtc_barcodeId`. Customer / Part No / Model have no value slot in the
P1 FG template, so they print blank (by design).

---

## 3. Reload-template mechanism (branch flow)

The label **design** isn't hardcoded — it's fetched from the MES template
(`LABEL_TEMPLATE_ID`, default `11` = "P1 FG Sticker") and cached for
`TEMPLATE_TTL_MS` (default 5 min). Print and Preview both call `getTemplate()`.

**Automatic (used by Print & Preview):**
`getTemplate()` → is the cached copy younger than the TTL?
- **Yes** → use the cached template.
- **No** → fetch fresh from MES.
  - Fetch OK → update cache → use fresh template.
  - Fetch fails → use the last cached copy if we have one → otherwise error.

**Manual (the Reload template button):**
Click Reload template → `POST /api/template/reload` → force a fresh fetch,
ignoring the cache.
- OK → replace cache → show template name + updated time → if the TSPL preview
  is open, re-fetch it to show the new design.
- Fails → show an error, leave the old cache untouched.

**How a MES design change reaches the printer:**
Edit template 11 in the MES designer → then either **wait ≤5 min** (auto), or
**click Reload template** (now), or **restart the app server** (now) → the next
Print/Preview uses the new design.

**Two things must hold for a change to reflect:**
1. **Same template id** — we fetch id `11`. If your edit saves as a *new*
   template or changes which one is *active*, update `LABEL_TEMPLATE_ID`.
2. **Known element types** — the renderer supports `text`, `bar`, `box`,
   `barcode`. A brand-new element *type* in the designer would be skipped; tell
   us and we add support.

> The on-screen HTML label is a **fixed preview** for quick recognition; it does
> not redraw from the MES design. To confirm a MES edit landed, use
> **Preview TSPL** or the printed label — those render from the live template.

---

## Config that controls this (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MES_BASE_URL` | EC2 :8081 | Where to fetch the template |
| `LABEL_TEMPLATE_ID` | `11` | Which template to print |
| `TEMPLATE_TTL_MS` | `300000` | Auto-refresh window (ms) |
| `AGENT_URL` | `http://localhost:9000` | Local print-agent |
| `PRINTER_TYPE` | `tsc` | Printer language path |
