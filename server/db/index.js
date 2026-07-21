/*
 * DB connector factory.
 * Picks the adapter named by DB_CLIENT (mock | mssql | postgres) and re-exports
 * its interface: search(term), getOne(jtcNo), close().
 *
 * Because every adapter exposes the same three functions, the rest of the app
 * never needs to know which database is behind it — swapping SQL Server for
 * PostgreSQL later is just a change of DB_CLIENT in .env.
 */

const client = (process.env.DB_CLIENT || 'mock').toLowerCase();

const adapters = {
  mock: () => require('./mock'),
  mssql: () => require('./mssql'),
  postgres: () => require('./postgres'),
};

if (!adapters[client]) {
  throw new Error(
    `Unknown DB_CLIENT "${client}". Use one of: ${Object.keys(adapters).join(', ')}`
  );
}

console.log(`[db] using adapter: ${client}`);

module.exports = adapters[client]();
module.exports.clientName = client;
