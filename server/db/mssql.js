/*
 * SQL Server adapter for the Avelon-Yollink MES. The SQL lives in
 * server/db/queries.js (the mssql section); this file is schema-agnostic — it
 * just runs those queries with the @jtc parameter bound.
 *
 * TO USE:
 *   1. npm i mssql
 *   2. set DB_CLIENT=mssql and the MSSQL_* values in .env
 *
 * The connection pool is created lazily on first use and reused after that.
 */

const { mssql: sql, modelExpr: MODEL_EXPR } = require('./queries');

let poolPromise = null;

function getPool() {
  if (poolPromise) return poolPromise;

  let mssql;
  try {
    mssql = require('mssql');
  } catch (e) {
    throw new Error(
      "The 'mssql' package is not installed. Run:  npm i mssql"
    );
  }

  const config = {
    server: process.env.MSSQL_SERVER || 'localhost',
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options: {
      encrypt: String(process.env.MSSQL_ENCRYPT).toLowerCase() === 'true',
      trustServerCertificate:
        String(process.env.MSSQL_TRUST_SERVER_CERT).toLowerCase() === 'true',
    },
  };

  // A named instance ("HOST\SQLEXPRESS") is reached by instance name, resolved
  // via the SQL Browser service (UDP 1434) — NOT by a fixed port. Put only the
  // host in MSSQL_SERVER and the instance in MSSQL_INSTANCE. A default instance
  // uses the port instead.
  if (process.env.MSSQL_INSTANCE) {
    config.options.instanceName = process.env.MSSQL_INSTANCE;
  } else {
    config.port = Number(process.env.MSSQL_PORT || 1433);
  }

  poolPromise = new mssql.ConnectionPool(config)
    .connect()
    .then((pool) => {
      // expose the module so callers can build typed requests
      pool._mssql = mssql;
      return pool;
    })
    .catch((err) => {
      poolPromise = null; // allow retry on next request
      throw err;
    });

  return poolPromise;
}

// `models` (optional) is an array of model names; when non-empty the results are
// limited to JTCs of those models (the calling tab's `models`). Empty/absent = all.
// The IN list is built as bound params (@m0, @m1, …) so it stays injection-safe and
// works on every SQL Server version (no STRING_SPLIT dependency).
// `doneOnly` (optional): when true, only completed jobs (ActualEndDate set) surface —
// for FG-Sticker tabs. No parameter needed; it's a fixed, safe clause.
// `toLocation` (optional): a Job.ToLocationId to pin the tab to (e.g. 18 = P3-OUTGOING).
async function search(term, models, doneOnly, toLocation) {
  const pool = await getPool();
  const req = pool.request().input('jtc', `%${term}%`);
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  let modelClause = '';
  if (list.length) {
    const params = list.map((m, i) => {
      req.input('m' + i, String(m).toUpperCase());
      return '@m' + i;
    });
    modelClause = `AND UPPER(${MODEL_EXPR}) IN (${params.join(', ')})`;
  }
  const doneClause = doneOnly ? 'AND j.ActualEndDate IS NOT NULL' : '';
  let locClause = '';
  if (Number.isInteger(toLocation)) {
    req.input('toloc', toLocation);
    locClause = 'AND j.ToLocationId = @toloc';
  }
  const result = await req.query(sql.searchBase(modelClause, doneClause, locClause));
  return result.recordset;
}

async function getOne(jtcNo) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('jtc', jtcNo)
    .query(sql.getOne);
  return result.recordset[0] || null;
}

// Jobs completed strictly after `since` (a JS Date), oldest-first — the auto-print
// watcher's poll. Bound @since with the driver's DateTime2 so the compare matches
// the datetime column; the Date round-trips the same instant the watcher stored.
async function getCompletedSince(since) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('since', pool._mssql.DateTime2, since)
    .query(sql.getCompletedSince);
  return result.recordset;
}

// Newest existing completion (a Date, or null on an empty table) — used once to
// seed the watcher's watermark so it ignores history.
async function getLatestCompletionMark() {
  const pool = await getPool();
  const result = await pool.request().query(sql.latestCompletion);
  return result.recordset[0]?.m || null;
}

async function close() {
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
  }
}

module.exports = { search, getOne, getCompletedSince, getLatestCompletionMark, close };
