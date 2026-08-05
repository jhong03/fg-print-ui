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
    // JTC No lives on `woNumber` — its true catalog meaning ("Work order no.").
    // Both P1's "JTC No" and P3's "W.O. NO." bind woNumber.
    // ⚠ P3 (template 13) must be rebound coNumber -> woNumber for this, otherwise
    //   its "W.O. NO." would show the C/O No instead of the JTC No.
    woNumber: r.woNumber || '',
    // C/O number = CustomerOrder.OrderNumber — its true catalog meaning.
    coNumber: jtcNo,
    // The part NAME / description. P1's "Part Name" and P3's "PART NAME" both
    // bind this key.
    partDesc: r.partName || '',
    dateIssue: formatDate(r.date),
    qty: r.qty != null ? String(r.qty) : '',
    jtc_barcodeId: barcode,
    customer: r.customer || '',
    model: r.model || '',

    // The catalog has NO dedicated "Part No" key, so feed the part number into a
    // free "Components" slot; bind P1's "Part No" element to remarksLine1. Nothing
    // else binds remarksLine1 (P3 uses remarksLine3/4), so P3 is unaffected.
    partName: r.partNo || '',   // P1 "Part No" (Product.PartNumber)

    // Work Order (P3) label fields.
    stockCode: r.stockCode || '',
    processCode: r.processCode || '',
    empNo: r.empNo || '',

    // Not sourced / unused by any current template.
    binId: '', lotNumber: '',
    remarksLine2: '', remarksLine3: '', remarksLine4: '',
    weightLine1: '', weightLine2: '', weightLine3: '', weightLine4: '',
  };
}

module.exports = { mapRecordToFields, formatDate };
