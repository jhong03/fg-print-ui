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
 * Prepend the location's configured process code to a painting record's process
 * code, in place. Used only on the welding->painting path so the WO label can show
 * "SB" (ShotBlast — the painting line's first physical station) ahead of the
 * painting routing's own step. MES models painting as a single "PL" step for some
 * models (K2VG/K1AJ/K2PM) and as "SB" for others (K2SA/K2SR):
 *   PL  + prepend "SB"  -> "SB, PL"
 *   SB  + prepend "SB"  -> "SB"        (already leads with it — no double-up)
 *   ""  + prepend "SB"  -> "SB"
 * Set locations.json `processCodePrepend` to "" (or remove it) to revert to the
 * MES routing as-is — no code change, takes effect on the next print.
 */
function prependProcessCode(record, loc) {
  const add = loc && String(loc.processCodePrepend || '').trim();
  if (!record || !add) return record;
  const cur = String(record.processCode || '').trim();
  const first = cur.split(',')[0].trim().toUpperCase();
  if (first === add.toUpperCase()) return record; // already leads with it
  record.processCode = cur ? `${add}, ${cur}` : add;
  return record;
}

/*
 * Resolve a fetched record + location to what should actually be printed/previewed.
 * Returns { record, sourceJtc }:
 *   - welding->painting location + the record is a Leak-Test job with a ParentJob
 *     → the Painting parent record (looked up via db.getOne), sourceJtc = welding JTC
 *   - otherwise → the record unchanged, sourceJtc = null
 * `db.getOne` resolves the parent by Job.Id (it accepts an id or an OrderNumber).
 * On a resolved painting record we also apply the location's processCodePrepend.
 */
async function resolvePainting(record, loc, db) {
  if (
    record &&
    loc && loc.weldingToPainting &&
    isLeakTest(record.processCode) &&
    record.parentJobId != null
  ) {
    const painting = await db.getOne(String(record.parentJobId));
    if (painting) {
      prependProcessCode(painting, loc);
      return { record: painting, sourceJtc: record.jtcNo };
    }
  }
  return { record, sourceJtc: null };
}

module.exports = { isLeakTest, resolvePainting, prependProcessCode };
