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

function mapRecordToFields(r, templateId, qrTags) {
  const jtcNo = (r.jtcNo || '').trim();
  const isWorkOrderTemplate = String(templateId) === '1';
  // Barcode encodes ONLY the JTC barcode id. When a job has none, we leave this
  // empty and the barcode element is skipped entirely (rather than falling back
  // to the long JTC No, which produced inconsistent barcode widths).
  const barcode = r.barcodeId != null && r.barcodeId !== ''
    ? String(r.barcodeId)
    : '';
  const startTag = isWorkOrderTemplate ? qrTags?.startTag : null;
  const endTag = isWorkOrderTemplate ? qrTags?.endTag : null;

  return {
    woNumber: r.woNumber || '',
    // Template 1 binds W.O. NO. to coNumber and has a dedicated JTC NO. field.
    // The W.O. value comes from CustomerOrder.OrderNumber.
    // Other templates still rely on the older coNumber binding for the JTC.
    coNumber: isWorkOrderTemplate ? String(r.coNo ?? '').trim() : jtcNo,
    ...(isWorkOrderTemplate ? { jtcNo } : {}),
    // The part NAME / description. P1's "Part Name" and P3's "PART NAME" both
    // bind this key.
    partDesc: r.partName || '',
    dateIssue: formatDate(r.date),
    qty: r.qty != null ? String(r.qty) : '',
    jtc_barcodeId: barcode,
    customer: r.customer || '',
    model: r.model || '',

    partName: r.partNo || '',   // P1 "Part No" (Product.PartNumber)

    // Work Order (P3) label fields.
    stockCode: r.stockCode || '',
    processCode: r.processCode || '',
    empNo: r.empNo || '',

    ...(isWorkOrderTemplate ? { remarksLine1: startTag == null ? '' : `Start QR: ${String(startTag).padStart(4, '0')}` } : {}),
    remarksLine2: endTag == null ? '' : `End QR: ${String(endTag).padStart(4, '0')}`,
    binId: '', lotNumber: '',
    remarksLine3: '', remarksLine4: '',
    weightLine1: '', weightLine2: '', weightLine3: '', weightLine4: '',
  };
}

module.exports = { mapRecordToFields, formatDate };
