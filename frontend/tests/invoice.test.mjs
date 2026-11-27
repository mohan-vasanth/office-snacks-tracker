import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceReport, formatINR, formatPdfINR, buildInvoicePdf, userWiseCsv, userWiseTotals, buildUserWisePdf } from '../src/invoiceReport.js';

const rec = (id, emp, name, snack, sname, qty, price, takenAt) => ({ id, employeeId: emp, employeeName: name, snackId: snack, snackName: sname, quantity: qty, unitPrice: price, takenAt });
const rows = [
  rec(1, 1, 'Asha', 10, 'Tea', 2, 10, '2026-11-02T04:00:00Z'),
  rec(2, 1, 'Asha', 11, 'Samosa', 3, 15.5, '2026-11-02T10:30:00Z'), // multiple snacks, one employee
  rec(3, 2, 'Ravi', 10, 'Tea', 1, 12, '2026-11-03T04:00:00Z'),      // same snack, historical price 12 (current may be 10)
  { id: 'ns-9', noSnacks: true, employeeId: 3, employeeName: 'Meena', snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null, takenAt: '2026-11-03T04:00:00Z' },
];

test('monthly total uses saved price x quantity per record', () => {
  const r = buildInvoiceReport(rows);
  assert.equal(r.grandTotal, 2 * 10 + 3 * 15.5 + 1 * 12); // 78.5
  assert.equal(r.totalRecords, 3);
  assert.equal(r.totalQuantity, 6);
  assert.equal(r.totalEmployees, 2);
  assert.equal(r.totalItems, 2);
});
test('multiple snacks for one employee are separate lines; employee summary aggregates', () => {
  const r = buildInvoiceReport(rows);
  assert.equal(r.lines.filter((l) => l.employeeName === 'Asha').length, 2);
  const asha = r.employees.find((e) => e.name === 'Asha');
  assert.deepEqual([asha.items, asha.quantity, asha.records, asha.amount], [2, 5, 2, 66.5]);
  assert.equal(r.employees.find((e) => e.name === 'Ravi').amount, 12);
  assert.equal(r.employees.reduce((t, e) => t + e.amount, 0), r.grandTotal);
});
test('No Snacks rows are never counted (employee, quantity, records, amount)', () => {
  const r = buildInvoiceReport(rows);
  assert.ok(!r.employees.some((e) => e.name === 'Meena'));
  assert.ok(!r.lines.some((l) => /no snacks/i.test(l.snackName)));
});
test('duplicate record ids are not double counted', () => {
  assert.equal(buildInvoiceReport([...rows, rows[0], rows[1]]).grandTotal, 78.5);
});
test('unpriced records are listed, counted, but add nothing to the amount; no float drift', () => {
  const r = buildInvoiceReport([rec(1, 1, 'A', 1, 'X', 3, 0.1, '2026-11-01T04:00:00Z'), rec(2, 1, 'A', 2, 'Y', 2, null, '2026-11-01T04:00:00Z')]);
  assert.equal(r.grandTotal, 0.3);
  assert.equal(r.unpricedRecords, 1);
  assert.equal(r.totalRecords, 2);
});
test('empty month', () => {
  const r = buildInvoiceReport([]);
  assert.deepEqual([r.grandTotal, r.totalRecords, r.totalEmployees, r.lines.length], [0, 0, 0, 0]);
});
test('Indian formatting', () => {
  assert.equal(formatINR(123456.5), '\u20B9 1,23,456.50');
  assert.equal(formatPdfINR(1234567), 'INR 12,34,567.00');
  assert.equal(formatINR(0), '\u20B9 0.00');
});
test('PDF builds for empty, small and multi-page reports', async () => {
  const { jsPDF } = await import('jspdf');
  const big = Array.from({ length: 140 }, (_, i) => rec(i + 1, (i % 7) + 1, `Employee ${(i % 7) + 1}`, (i % 5) + 1, `Snack ${(i % 5) + 1}`, 1 + (i % 3), 10 + (i % 5), `2026-11-${String((i % 27) + 1).padStart(2, '0')}T04:00:00Z`));
  for (const [rs, minPages] of [[[], 1], [rows, 1], [big, 3]]) {
    const pdf = buildInvoicePdf(jsPDF, { report: buildInvoiceReport(rs), monthLabel: 'November 2026', month: '2026-11', generatedOn: 'test' });
    assert.ok(pdf.getNumberOfPages() >= minPages);
    assert.ok(pdf.output('arraybuffer').byteLength > 1000);
  }
});

const GROUPS = [
  { name: 'Asha', snacks: [{ name: 'Samosa', quantity: 3 }, { name: 'Tea', quantity: 2 }], quantity: 5, records: 2, amount: 66.5, unpricedRecords: 0 },
  { name: '=Evil', snacks: [{ name: 'Vada', quantity: 2 }], quantity: 2, records: 1, amount: 0.1, unpricedRecords: 1 },
  { name: 'Ravi "R"', snacks: [{ name: 'Tea', quantity: 1 }], quantity: 1, records: 1, amount: 0.2, unpricedRecords: 0 },
];
test('user-wise CSV: header, one row per employee, escaped cells, exact total', () => {
  const lines = userWiseCsv(GROUPS).replace('﻿', '').trim().split('\r\n');
  assert.equal(lines[0], '"Employee","Snacks Taken","Total Quantity","Records","Total Amount (INR)","Records Without Price"');
  assert.equal(lines[1], '"Asha","Samosa x 3; Tea x 2","5","2","66.50","0"');
  assert.ok(lines[2].startsWith(`"'=Evil"`)); // formula injection guard
  assert.ok(lines[3].startsWith('"Ravi ""R"""'));
  assert.equal(lines[4], '"Total","","8","4","66.80","1"');
  assert.deepEqual(userWiseTotals(GROUPS), { quantity: 8, records: 4, amount: 66.8, unpriced: 1 });
});
test('user-wise CSV with no data still has a header and a zero total', () => {
  const lines = userWiseCsv([]).replace('﻿', '').trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '"Total","","0","0","0.00","0"');
});
test('user-wise PDF builds for empty, small and multi-page lists', async () => {
  const { jsPDF } = await import('jspdf');
  const many = Array.from({ length: 90 }, (_, i) => ({ name: `Employee ${i + 1}`, snacks: [{ name: 'Tea', quantity: 2 }, { name: 'Samosa', quantity: 1 }], quantity: 3, records: 2, amount: 40, unpricedRecords: 0 }));
  for (const [g, min] of [[[], 1], [GROUPS, 1], [many, 2]]) {
    const pdf = buildUserWisePdf(jsPDF, { groups: g, label: 'November 2026', filename: 'x.pdf', generatedOn: 'test' });
    assert.ok(pdf.getNumberOfPages() >= min);
    assert.ok(pdf.output('arraybuffer').byteLength > 1000);
  }
});
