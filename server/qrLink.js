/*
 * QR ↔ JTC binding log (PostgreSQL).
 *
 * The job/record data lives in SQL Server (DB_CLIENT=mssql), but the QR-binding
 * result is written to a SEPARATE PostgreSQL table `public.qr_jtc_link`:
 *
 *   id            -- PK (DB-generated identity; the app does NOT send it)
 *   jtc_barcodeId -- the printed painting JTC's Job.Id (the *j<id> barcode value)
 *   qr_start      -- the Green/Start tag scanned, as an int (e.g. 2101)
 *   qr_end        -- the Red/End tag scanned,   as an int (e.g. 2201)
 *
 * This is its OWN connection (separate pool from the read DB), configured with
 * QRPG_* env vars, falling back to the PG_* vars if those are unset. It is
 * best-effort: a write failure is logged but never blocks the actual print — the
 * compliance gate already passed by the time we get here.
 */

let pool = null;
let disabled = false;

function env(name, fallback) {
  return process.env['QRPG_' + name] || process.env['PG_' + name] || fallback;
}

function getPool() {
  if (pool) return pool;
  let pg;
  try {
    pg = require('pg');
  } catch (_) {
    throw new Error("The 'pg' package is not installed. Run:  npm i pg");
  }
  pool = new pg.Pool({
    host: env('HOST', 'localhost'),
    port: Number(env('PORT', 5432)),
    database: env('DATABASE'),
    user: env('USER'),
    password: env('PASSWORD'),
    ssl: String(env('SSL', '')).toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  return pool;
}

// Insert one binding row. Returns { ok, id? } / { ok:false, error }. Never throws.
async function record({ jtcBarcodeId, qrStart, qrEnd }) {
  if (disabled) return { ok: false, error: 'qrLink disabled (missing config)' };
  if (!env('DATABASE') || !env('USER')) {
    disabled = true; // no PG config -> stop trying, log once
    console.warn('[qrLink] no QRPG_*/PG_* config — QR bindings will NOT be logged to Postgres');
    return { ok: false, error: 'no config' };
  }
  try {
    const { rows } = await getPool().query(
      'INSERT INTO public.qr_jtc_link ("jtc_barcodeId", qr_start, qr_end) VALUES ($1, $2, $3) RETURNING id',
      [jtcBarcodeId, qrStart, qrEnd]
    );
    return { ok: true, id: rows[0]?.id };
  } catch (err) {
    console.error('[qrLink] insert failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { record, close };
