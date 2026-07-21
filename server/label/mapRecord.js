/*
 * Maps our JTC record (from the DB adapter) onto the MES label field keys used
 * by the templates. Only a subset is used by the P1 FG Sticker template
 * (partName, dateIssue, qty, woNumber, coNumber, jtc_barcodeId); the rest are
 * provided empty so any template renders cleanly.
 */

function formatDate(v) {
  if (!v) return '';
  const s = String(v);
  if (s.includes('/')) return s.trim(); // already dd/mm/yyyy
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); // ISO date/timestamp
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
  return s;
}

function mapRecordToFields(r) {
  const jtcNo = (r.jtcNo || '').trim();
  // Barcode encodes ONLY the JTC barcode id. When a job has none, we leave this
  // empty and the barcode element is skipped entirely (rather than falling back
  // to the long JTC No, which produced inconsistent barcode widths).
  const barcode = r.barcodeId != null && r.barcodeId !== ''
    ? String(r.barcodeId)
    : '';

  return {
    coNumber: jtcNo,
    woNumber: r.woNo || '',
    partName: r.partName || '',
    dateIssue: formatDate(r.date),
    qty: r.qty != null ? String(r.qty) : '',
    jtc_barcodeId: barcode,

    // Present in our data but not bound by the P1 FG template (kept for other
    // templates / future use).
    customer: r.customer || '',
    partNo: r.partNo || '',
    model: r.model || '',

    // Not sourced yet — emitted empty.
    stockCode: '', processCode: '', empNo: '', binId: '', lotNumber: '',
    remarksLine1: '', remarksLine2: '', remarksLine3: '', remarksLine4: '',
    weightLine1: '', weightLine2: '', weightLine3: '', weightLine4: '',
  };
}

module.exports = { mapRecordToFields, formatDate };
