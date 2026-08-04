/*
 * Mock adapter — built-in sample data, no database required.
 * Lets you run and demo the UI immediately. Selected when DB_CLIENT=mock.
 * Delete or ignore once the real adapters are wired up.
 */

// Existing completions are dated in the PAST (yesterday) so that when a test
// flips a job "now", the new timestamp is always newer than the seeded watermark
// regardless of the clock/timezone — the watcher will see it as a fresh event.
const RECORDS = [
  {
    jobId: 1001,
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
    actualEnd: '2026-07-27T09:00:00Z',
  },
  {
    jobId: 1002,
    jtcNo: 'J2606-118A02TRX-LD',
    customer: 'NIPPON AUTO PARTS',
    partName: 'A02-0210-BR BRACKET',
    partNo: 'A02-0210-BR',
    model: 'TRX-LD',
    date: '10/07/2026',
    qty: 200,
    uom: 'PCS',
    woNo: 'WO-2026-0207',
    actualEnd: '2026-07-27T09:05:00Z',
  },
  {
    jobId: 1003,
    jtcNo: 'J2607-004C77PLT-ST',
    customer: 'SILVERLINE ENGINEERING',
    partName: 'C77-0043-PL BASE PLATE',
    partNo: 'C77-0043-PL',
    model: 'PLT-ST',
    date: '15/07/2026',
    qty: 120,
    uom: 'PCS',
    woNo: 'WO-2026-0221',
    actualEnd: '2026-07-27T09:10:00Z',
  },
  // Auto-print trigger test job — mirrors a real K0WY Work Order (P3) job, but
  // NOT completed yet (actualEnd: null). Flip it with POST /api/dev/complete to
  // reproduce the exact NULL -> set event the watcher fires on. Fields populated
  // so template 13 renders fully; edit them to match a real job if you like.
  {
    jobId: 35663,
    jtcNo: 'J2607-834E23FGM-HD (1/46)  / E23-0100-WF',
    customer: 'YOLLINK TEST',
    partName: 'E21-0100',
    partNo: 'E21-0100',
    model: 'K0WY',
    date: '28/07/2026',
    qty: 46,
    uom: 'PCS',
    woNo: '',
    coNo: '',
    barcodeId: '35663',
    stockCode: 'SC-K0WY-01',
    processCode: 'LKT',
    empNo: 'EMP-777',
    actualEnd: null,
  },
  // --- Welding -> Painting flow test pair (K2VG) ---------------------------
  // Painting Line JTC = the LABEL DATA source (no -WF, no suffix, processCode PL).
  // It is the ParentJob of the welding job below; not completed (data only).
  {
    jobId: 91001,
    jtcNo: 'J2606-594E23FGM-HD (40/40)',
    customer: 'KOIKE (M) SDN BHD (BATU KAWAN)',
    partName: 'MUFFLER COMP, EXHAUST',
    partNo: 'E23-0100',
    model: 'K2VG',
    date: '30/07/2026',
    qty: 50,
    uom: 'PCS',
    coNo: '',
    barcodeId: '91001',
    stockCode: 'E23-0100',
    processCode: 'PL',
    empNo: 'EMP-500',
    parentJobId: null,
    parentJtcNo: null,
    actualEnd: null,
  },
  // Welding Line JTC = the TRIGGER (has -WF suffix + stock code, processCode L-T).
  // On completion the watcher follows parentJtcNo -> the Painting JTC above and
  // prints THAT label. Flip with POST /api/dev/complete { "id": 91002 }.
  {
    jobId: 91002,
    parentJobId: 91001,
    jtcNo: 'J2606-594E23FGM-HD (40/40)  / E23-0100-WF',
    parentJtcNo: 'J2606-594E23FGM-HD (40/40)',
    customer: 'KOIKE (M) SDN BHD (BATU KAWAN)',
    partName: 'MUFFLER COMP, EXHAUST (WOF)',
    partNo: 'E23-0100-WF',
    model: 'K2VG',
    date: '29/07/2026',
    qty: 50,
    uom: 'PCS',
    coNo: '',
    barcodeId: '91002',
    stockCode: 'E23-0100-WF',
    processCode: 'L-T',
    empNo: 'EMP-500',
    actualEnd: null,
  },
];

async function search(term, models) {
  const q = term.toLowerCase();
  // Model filter mirrors mssql: when the calling tab has models, only its models
  // surface. Empty/absent = all.
  const set = Array.isArray(models) && models.length
    ? new Set(models.map((m) => String(m).trim().toUpperCase()))
    : null;
  return RECORDS
    .filter((r) => r.jtcNo.toLowerCase().includes(q))
    .filter((r) => !set || set.has(String(r.model || '').trim().toUpperCase()))
    .slice(0, 10)
    .map((r) => ({ jtcNo: r.jtcNo, partName: r.partName }));
}

// Matches the JTC No (OrderNumber) OR the Job.Id, like the real mssql getOne —
// so resolving a ParentJob by id (welding->painting) works here too.
async function getOne(key) {
  return RECORDS.find((r) => r.jtcNo === key || String(r.jobId) === String(key)) || null;
}

// Auto-print watcher support. `since` is a Date; return completions strictly
// after it, oldest-first. Sample completions sit in the past, so with a live
// "now" watermark the watcher stays quiet — pass an older `since` to exercise it.
async function getCompletedSince(since) {
  const s = new Date(since).getTime();
  return RECORDS
    .filter((r) => r.actualEnd && new Date(r.actualEnd).getTime() > s)
    .sort((a, b) => new Date(a.actualEnd) - new Date(b.actualEnd));
}

async function getLatestCompletionMark() {
  const times = RECORDS.filter((r) => r.actualEnd).map((r) => new Date(r.actualEnd));
  return times.length ? new Date(Math.max(...times)) : null;
}

// --- Local test controls (mock only) ---------------------------------------
// The routes that call these are hard-guarded to DB_CLIENT=mock, so they can
// never mutate a real database. __complete flips a job NULL -> completed (the
// exact event the watcher detects); __reset clears it back so it can be re-run.
function find(key) {
  return RECORDS.find((r) => r.jtcNo === key || String(r.jobId) === String(key)) || null;
}

function __complete(key) {
  const r = find(key);
  if (!r) return null;
  r.actualEnd = new Date().toISOString();
  return { jobId: r.jobId, jtcNo: r.jtcNo, model: r.model, actualEnd: r.actualEnd };
}

function __reset(key) {
  const r = find(key);
  if (!r) return null;
  r.actualEnd = null;
  return { jobId: r.jobId, jtcNo: r.jtcNo, actualEnd: null };
}

module.exports = {
  search, getOne, getCompletedSince, getLatestCompletionMark,
  __complete, __reset, close: async () => {},
};
