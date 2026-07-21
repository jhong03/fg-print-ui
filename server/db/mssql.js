/*
 * SQL Server adapter (placeholder).
 *
 * TO ENABLE:
 *   1. npm i mssql
 *   2. set DB_CLIENT=mssql and the MSSQL_* values in .env
 *   3. put your real SQL in server/db/queries.js  (the mssql section)
 *
 * The connection pool is created lazily on first use and reused after that.
 */

const { mssql: sql } = require('./queries');

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
    port: Number(process.env.MSSQL_PORT || 1433),
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options: {
      encrypt: String(process.env.MSSQL_ENCRYPT).toLowerCase() === 'true',
      trustServerCertificate:
        String(process.env.MSSQL_TRUST_SERVER_CERT).toLowerCase() === 'true',
    },
  };

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

async function search(term) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('jtc', `%${term}%`)
    .query(sql.search);
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

async function close() {
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
  }
}

module.exports = { search, getOne, close };
