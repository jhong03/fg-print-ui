/*
 * Rework QR <-> JTC audit writer (PostgreSQL).
 *
 * MES job data is read from SQL Server. The rework link is written to the
 * separate PostgreSQL table public.rework_qr_link. The caller resolves the
 * Painting JTC through the MES adapter and passes its Job.Id as jtcId.
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
    ssl: String(env('SSL', '')).toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });
  return pool;
}

/*
 * Record the first Rework QR binding for one JTC.
 * The same Black QR may be reused for other JTCs. A JTC already linked to a
 * different QR is rejected; the same JTC + same QR is idempotent for recovery.
 */
async function record({ qrId, jtcId, remarks = null }) {
  if (disabled) return { ok: false, error: 'reworkQrLink disabled (missing config)' };
  if (!env('DATABASE') || !env('USER')) {
    disabled = true;
    console.warn('[reworkQrLink] no QRPG_*/PG_* config — Rework links will NOT be logged');
    return { ok: false, error: 'No PostgreSQL QR-link configuration is available.' };
  }

  const client = await getPool().connect();
  try {
    if (jtcId == null || !Number.isInteger(Number(jtcId))) {
      return { ok: false, error: 'The Painting JTC has no valid SQL Server Job.Id.' };
    }
    jtcId = Number(jtcId);

    const existing = await client.query(
      `SELECT id, qr_id
         FROM public.rework_qr_link
        WHERE "jtc_barcodeId" = $1
        ORDER BY id ASC
        LIMIT 1`,
      [jtcId]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (String(row.qr_id) === String(qrId)) {
        return { ok: true, existing: true, id: row.id, jtcId };
      }
      return {
        ok: false,
        reason: 'already-bound',
        error: `This JTC is currently bound to another Rework QR already.`,
        id: row.id,
        jtcId,
      };
    }

    const inserted = await client.query(
      `INSERT INTO public.rework_qr_link (qr_id, "jtc_barcodeId", remarks)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [String(qrId), jtcId, remarks]
    );
    return { ok: true, id: inserted.rows[0]?.id, jtcId };
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { record, close };
