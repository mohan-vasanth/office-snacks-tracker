// Monthly "Total Amount Report" (invoice style): pure calculation + PDF builder.
// Uses only the saved snack_records rows (saved unit_price x quantity). No schema or price changes.

const IST = 'Asia/Kolkata';
const dayOf = (r) => r.day || new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(new Date(r.takenAt));

// Indian digit grouping, always 2 decimals: 123456.5 -> "1,23,456.50"
export const formatINRNumber = (value) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
export const formatINR = (value) => `₹ ${formatINRNumber(value)}`;
// Standard PDF fonts have no rupee glyph, so the PDF uses the "INR" prefix (same as the existing PDFs).
export const formatPdfINR = (value) => `INR ${formatINRNumber(value)}`;

const paise = (n) => Math.round(Number(n) * 100);

export function formatDisplayDate(day) {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/**
 * @param rows records as returned by GET /records (id, employeeId, employeeName, snackId, snackName, quantity, unitPrice, takenAt)
 * No Snacks rows (noSnacks flag / null quantity) are ignored: they are never expenses.
 * A record without a saved price is listed but contributes 0 to totals and is counted in `unpricedRecords`.
 */
export function buildInvoiceReport(rows) {
  const seen = new Set();
  const lines = [];
  for (const r of rows || []) {
    if (!r || r.noSnacks || r.quantity == null) continue;
    const quantity = Number(r.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    if (r.id != null) { if (seen.has(String(r.id))) continue; seen.add(String(r.id)); }
    const priced = r.unitPrice != null && Number.isFinite(Number(r.unitPrice));
    lines.push({
      id: r.id,
      day: dayOf(r),
      takenAt: r.takenAt,
      employeeId: r.employeeId,
      employeeName: r.employeeName || 'Unknown',
      snackId: r.snackId,
      snackName: r.snackName || 'Unknown',
      quantity,
      unitPrice: priced ? Number(r.unitPrice) : null,
      paise: priced ? paise(r.unitPrice) * quantity : 0,
      total: priced ? (paise(r.unitPrice) * quantity) / 100 : null,
    });
  }
  lines.sort((a, b) => a.day.localeCompare(b.day) || a.employeeName.localeCompare(b.employeeName) || a.snackName.localeCompare(b.snackName) || String(a.takenAt).localeCompare(String(b.takenAt)) || Number(a.id) - Number(b.id));

  const byEmployee = new Map();
  for (const l of lines) {
    const key = l.employeeId ?? l.employeeName;
    const e = byEmployee.get(key) || { employeeId: l.employeeId, name: l.employeeName, snackIds: new Set(), records: 0, quantity: 0, paise: 0 };
    e.snackIds.add(l.snackId ?? l.snackName);
    e.records += 1;
    e.quantity += l.quantity;
    e.paise += l.paise;
    byEmployee.set(key, e);
  }
  const employees = [...byEmployee.values()]
    .map((e) => ({ employeeId: e.employeeId, name: e.name, items: e.snackIds.size, records: e.records, quantity: e.quantity, amount: e.paise / 100 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalPaise = lines.reduce((t, l) => t + l.paise, 0);
  return {
    lines,
    employees,
    totalEmployees: employees.length,
    totalItems: new Set(lines.map((l) => l.snackId ?? l.snackName)).size, // distinct snack items consumed
    totalRecords: lines.length,
    totalQuantity: lines.reduce((t, l) => t + l.quantity, 0),
    unpricedRecords: lines.filter((l) => l.unitPrice == null).length,
    grandTotal: totalPaise / 100,
  };
}

export function invoiceFilename(month) {
  return `OpalMinds_Invoice_Report_${month}.pdf`;
}

export function buildInvoicePdf(JsPDF, { report, monthLabel, month, generatedOn }) {
  const MINT = [37, 99, 235], DEEP = [23, 37, 84], CREAM = [248, 250, 252], TEXT = [15, 23, 42], MUTED = [100, 116, 139], LINE = [226, 232, 240], PALE = [239, 246, 255];
  const pdf = new JsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight(), margin = 40, usable = pageW - margin * 2;
  const filename = invoiceFilename(month);
  pdf.setProperties({ title: `Monthly Snack Expense Report - ${monthLabel}`, subject: 'Office Snacks Tracker invoice-style monthly report', creator: 'Office Snacks Tracker' });
  let y = 0;

  const header = (first) => {
    pdf.setFillColor(...DEEP); pdf.rect(0, 0, pageW, first ? 112 : 40, 'F');
    pdf.setFillColor(...MINT); pdf.rect(0, first ? 108 : 36, pageW, 4, 'F');
    pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold');
    if (first) {
      pdf.setFontSize(21); pdf.text('OFFICE SNACKS TRACKER', margin, 44);
      pdf.setFontSize(11); pdf.text('MONTHLY SNACK EXPENSE REPORT', margin, 66);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10); pdf.text(`Report Month: ${monthLabel}`, margin, 88);
      pdf.setFontSize(8); pdf.text(`Generated: ${generatedOn}`, pageW - margin, 88, { align: 'right' });
    } else {
      pdf.setFontSize(11); pdf.text('OFFICE SNACKS TRACKER', margin, 25);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.text(`Monthly Snack Expense Report - ${monthLabel}`, pageW - margin, 25, { align: 'right' });
    }
  };
  const newPage = () => { pdf.addPage(); header(false); y = 66; };
  const ensure = (h) => { if (y + h > pageH - 44) newPage(); };
  const section = (title) => { ensure(48); pdf.setTextColor(...DEEP); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.text(title, margin, y); pdf.setDrawColor(...MINT); pdf.setLineWidth(1.5); pdf.line(margin, y + 5, margin + 36, y + 5); y += 20; };

  header(true); y = 134;
  const cards = [['TOTAL EMPLOYEES', String(report.totalEmployees)], ['SNACK RECORDS', String(report.totalRecords)], ['TOTAL QUANTITY', String(report.totalQuantity)], ['TOTAL AMOUNT', formatPdfINR(report.grandTotal)]];
  const gap = 10, cw = (usable - gap * 3) / 4;
  cards.forEach(([label, value], i) => {
    const x = margin + i * (cw + gap);
    pdf.setFillColor(...CREAM); pdf.setDrawColor(...LINE); pdf.setLineWidth(0.8); pdf.roundedRect(x, y, cw, 54, 6, 6, 'FD');
    pdf.setFillColor(...MINT); pdf.rect(x, y + 10, 3, 34, 'F');
    pdf.setTextColor(...MUTED); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.text(label, x + 12, y + 20);
    pdf.setTextColor(...DEEP); pdf.setFontSize(i === 3 ? 11 : 15); pdf.text(value, x + 12, y + 41);
  });
  y += 72;

  const table = (headers, widths, aligns, body) => {
    const hh = 22, pad = 6, lh = 11;
    const head = () => {
      pdf.setFillColor(...MINT); pdf.rect(margin, y, usable, hh, 'F'); pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8);
      let x = margin; headers.forEach((t, i) => { const w = widths[i]; pdf.text(t, aligns[i] === 'r' ? x + w - 6 : x + 6, y + 14, { align: aligns[i] === 'r' ? 'right' : 'left' }); x += w; }); y += hh;
    };
    ensure(hh + 30); head();
    body.forEach((row, ri) => {
      const cells = row.map((v, i) => pdf.splitTextToSize(String(v), widths[i] - 12));
      const h = Math.max(...cells.map((c) => c.length)) * lh + pad * 2;
      if (y + h > pageH - 44) { newPage(); head(); }
      if (ri % 2 === 1) { pdf.setFillColor(...CREAM); pdf.rect(margin, y, usable, h, 'F'); }
      pdf.setDrawColor(...LINE); pdf.setLineWidth(0.5); pdf.line(margin, y + h, margin + usable, y + h);
      pdf.setTextColor(...TEXT); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
      let x = margin; cells.forEach((c, i) => { const w = widths[i]; pdf.text(c, aligns[i] === 'r' ? x + w - 6 : x + 6, y + pad + 8, { align: aligns[i] === 'r' ? 'right' : 'left' }); x += w; }); y += h;
    });
    y += 18;
  };
  const note = (text) => { pdf.setTextColor(...MUTED); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.text(text, margin, y + 4); y += 26; };

  section('Detailed Snack Transactions');
  if (report.lines.length) {
    table(['DATE', 'EMPLOYEE NAME', 'SNACK NAME', 'QTY', 'UNIT PRICE', 'TOTAL'], [usable * .15, usable * .25, usable * .24, usable * .08, usable * .14, usable * .14], ['l', 'l', 'l', 'r', 'r', 'r'],
      report.lines.map((l) => [formatDisplayDate(l.day), l.employeeName, l.snackName, l.quantity, l.unitPrice == null ? 'No price' : formatPdfINR(l.unitPrice), l.total == null ? 'No price' : formatPdfINR(l.total)]));
  } else note('No snack records were found for this month.');

  section('Employee-wise Summary');
  if (report.employees.length) {
    table(['EMPLOYEE NAME', 'TOTAL ITEMS', 'TOTAL QUANTITY', 'TOTAL AMOUNT'], [usable * .38, usable * .16, usable * .18, usable * .28], ['l', 'r', 'r', 'r'],
      report.employees.map((e) => [e.name, e.items, e.quantity, formatPdfINR(e.amount)]));
  } else note('No employee consumption for this month.');

  ensure(report.unpricedRecords ? 88 : 66);
  pdf.setFillColor(...DEEP); pdf.roundedRect(margin, y, usable, 44, 6, 6, 'F');
  pdf.setFillColor(...MINT); pdf.roundedRect(margin, y, 8, 44, 4, 4, 'F');
  pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.text('GRAND TOTAL', margin + 24, y + 27);
  pdf.setFontSize(15); pdf.text(formatPdfINR(report.grandTotal), pageW - margin - 14, y + 28, { align: 'right' });
  y += 58;
  if (report.unpricedRecords) { pdf.setTextColor(...MUTED); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.text(`${report.unpricedRecords} record(s) have no saved price and are not included in the total.`, margin, y); y += 14; }
  pdf.setTextColor(...MUTED); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.text('No Snacks entries are not expenses and are excluded from all quantities and amounts.', margin, y);

  const pages = pdf.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i); pdf.setDrawColor(...LINE); pdf.setLineWidth(0.5); pdf.line(margin, pageH - 30, pageW - margin, pageH - 30);
    pdf.setTextColor(...MUTED); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.text(filename, margin, pageH - 16); pdf.text(`Page ${i} of ${pages}`, pageW - margin, pageH - 16, { align: 'right' });
  }
  return pdf;
}
