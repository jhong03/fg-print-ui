/*
 * Standalone SQL Server connectivity check — run BEFORE flipping the app to
 * DB_CLIENT=mssql, so a bad connection surfaces here with a clear reason instead
 * of as a failed label lookup.
 *
 *   npm i mssql
 *   node scripts/check-mssql.js
 *
 * It reads the same MSSQL_* values from .env that the app does, then runs three
 * escalating checks:
 *   1. connect + SELECT 1     -> network / auth / instance resolution
 *   2. SELECT TOP 1 dbo.Job   -> right database, table visible
 *   3. the real search query  -> the joins in queries.js actually run
 */

require('dotenv').config();

let mssql;
try {
  mssql = require('mssql');
} catch (_) {
  console.error('\n✗ The "mssql" package is not installed.  Run:  npm i mssql\n');
  process.exit(1);
}

const { mssql: sql } = require('../server/db/queries');

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
  connectionTimeout: 8000,
};
if (process.env.MSSQL_INSTANCE) {
  config.options.instanceName = process.env.MSSQL_INSTANCE;
} else {
  config.port = Number(process.env.MSSQL_PORT || 1433);
}

const target =
  config.server +
  (config.options.instanceName ? '\\' + config.options.instanceName : ':' + config.port) +
  ' / ' + (config.database || '(no database set)');

async function main() {
  console.log('\nConnecting to', target, 'as', config.user || '(no user)', '...');
  let pool;
  try {
    pool = await mssql.connect(config);
  } catch (err) {
    console.error('\n✗ Could not connect:', err.message);
    hint(err);
    process.exit(2);
  }
  console.log('✓ Connected.');

  try {
    await pool.request().query('SELECT 1 AS ok');
    console.log('✓ SELECT 1 ran (server is answering queries).');

    const t = await pool.request().query('SELECT TOP 1 Id, OrderNumber FROM dbo.Job');
    console.log('✓ dbo.Job readable. Sample:', t.recordset[0] || '(table empty)');

    const s = await pool.request().input('jtc', '%%').query(sql.search);
    console.log(`✓ search query ran, returned ${s.recordset.length} row(s).`);
    if (s.recordset[0]) console.log('  e.g.', s.recordset[0]);

    console.log('\nAll checks passed — safe to set DB_CLIENT=mssql.\n');
  } catch (err) {
    console.error('\n✗ Connected, but a query failed:', err.message);
    console.error('  (Connection is fine — check the database name, table names, or JOINs in queries.js.)\n');
    process.exit(3);
  } finally {
    await pool.close();
  }
}

function hint(err) {
  const m = (err.message || '').toLowerCase();
  if (config.options.instanceName && (m.includes('instance') || m.includes('socket') || m.includes('timeout'))) {
    console.error('  Hint: named instance not found. The SQL Browser service (UDP 1434) must be');
    console.error('        running and reachable, OR use a static port instead: clear MSSQL_INSTANCE');
    console.error('        and set MSSQL_PORT to the instance\'s real port.');
  } else if (m.includes('login') || m.includes('password')) {
    console.error('  Hint: auth failed. Check MSSQL_USER / MSSQL_PASSWORD, and that SQL Server');
    console.error('        allows SQL logins (Mixed Mode), not Windows-only auth.');
  } else if (m.includes('self-signed') || m.includes('certificate')) {
    console.error('  Hint: TLS cert rejected. Set MSSQL_TRUST_SERVER_CERT=true for a local/dev server.');
  } else {
    console.error('  Hint: check host/port reachability (firewall, VPN) and that TCP/IP is enabled');
    console.error('        in SQL Server Configuration Manager for this instance.');
  }
  console.error('');
}

main();
