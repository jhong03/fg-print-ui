/*
 * Mock adapter — built-in sample data, no database required.
 * Lets you run and demo the UI immediately. Selected when DB_CLIENT=mock.
 * Delete or ignore once the real adapters are wired up.
 */

const RECORDS = [
  {
    jtcNo: 'J2606-593E21FGM-HD',
    customer: 'ACME MOTORS BHD',
    partName: 'E21-0100-WF MUFFLER',
    partNo: 'E21-0100-WF',
    model: 'FGM-HD',
    date: '08/07/2026',
    qty: 50,
    uom: 'PCS',
    woNo: 'WO-2026-0193',
    barcodeId: '2606593021',
  },
  {
    jtcNo: 'J2606-118A02TRX-LD',
    customer: 'NIPPON AUTO PARTS',
    partName: 'A02-0210-BR BRACKET',
    partNo: 'A02-0210-BR',
    model: 'TRX-LD',
    date: '10/07/2026',
    qty: 200,
    uom: 'PCS',
    woNo: 'WO-2026-0207',
  },
  {
    jtcNo: 'J2607-004C77PLT-ST',
    customer: 'SILVERLINE ENGINEERING',
    partName: 'C77-0043-PL BASE PLATE',
    partNo: 'C77-0043-PL',
    model: 'PLT-ST',
    date: '15/07/2026',
    qty: 120,
    uom: 'PCS',
    woNo: 'WO-2026-0221',
  },
];

async function search(term) {
  const q = term.toLowerCase();
  return RECORDS
    .filter((r) => r.jtcNo.toLowerCase().includes(q))
    .slice(0, 10)
    .map((r) => ({ jtcNo: r.jtcNo, partName: r.partName }));
}

async function getOne(jtcNo) {
  return RECORDS.find((r) => r.jtcNo === jtcNo) || null;
}

module.exports = { search, getOne, close: async () => {} };
