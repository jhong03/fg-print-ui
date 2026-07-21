/*
 * PostgreSQL adapter (placeholder) — for the planned transition off SQL Server.
 *
 * TO ENABLE:
 *   1. npm i pg
 *   2. set DB_CLIENT=postgres and the PG_* values in .env
 *   3. put your real SQL in server/db/queries.js  (the postgres section)
 */

const { postgres: sql } = require('./queries');

let pool = null;

function getPool() {
  if (pool) return pool;

  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    throw new Error("The 'pg' package is not installed. Run:  npm i pg");
  }

  pool = new pg.Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl:
      String(process.env.PG_SSL).toLowerCase() === 'true'
        ? { rejectUnauthorized: false }
        : false,
  });

  return pool;
}

async function search(term) {
  const { rows } = await getPool().query(sql.search, [`%${term}%`]);
  return rows;
}

async function getOne(jtcNo) {
  const { rows } = await getPool().query(sql.getOne, [jtcNo]);
  return rows[0] || null;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { search, getOne, close };
