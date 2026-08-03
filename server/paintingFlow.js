/*
 * Welding -> Painting resolution, shared by the auto-print watcher and the manual
 * lookup/preview/print routes.
 *
 * A "welding->painting" location (locations.json `weldingToPainting:true`) does not
 * print the completing/entered job. If that job is a **Welding Line Leak-Test job**
 * (processCode L-T/LKT) it is only a *trigger*: we follow its `ParentJob` to the
 * **Painting Line JTC** and act on THAT — while remembering the welding JTC as the
 * provenance ("came from") shown in the preview and queue.
 *
 * See PROJECT_CONTEXT.md §17.
 */

// Leak-Test process codes = "welding line done". Both spellings occur in the data
// (L-T is actually the more common). A job's processCode is a comma-joined list of
// its flow steps, so we token-match.
const LEAK_TEST_CODES = new Set(['L-T', 'LKT']);

function isLeakTest(processCode) {
  return String(processCode || '')
    .split(',')
    .some((t) => LEAK_TEST_CODES.has(t.trim().toUpperCase()));
}

/*
 * Resolve a fetched record + location to what should actually be printed/previewed.
 * Returns { record, sourceJtc }:
 *   - welding->painting location + the record is a Leak-Test job with a ParentJob
 *     → the Painting parent record (looked up via db.getOne), sourceJtc = welding JTC
 *   - otherwise → the record unchanged, sourceJtc = null
 * `db.getOne` resolves the parent by Job.Id (it accepts an id or an OrderNumber).
 */
async function resolvePainting(record, loc, db) {
  if (
    record &&
    loc && loc.weldingToPainting &&
    isLeakTest(record.processCode) &&
    record.parentJobId != null
  ) {
    const painting = await db.getOne(String(record.parentJobId));
    if (painting) return { record: painting, sourceJtc: record.jtcNo };
  }
  return { record, sourceJtc: null };
}

module.exports = { isLeakTest, resolvePainting };
