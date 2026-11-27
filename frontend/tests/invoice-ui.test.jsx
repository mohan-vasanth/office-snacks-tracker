// Setup (not part of the app build): in an empty scratch folder run
//   npm i vitest@2 jsdom @testing-library/react@16 react@18.3.1 react-dom@18.3.1
// add a vitest config that aliases react/react-dom to that folder, inlines @testing-library, react, react-dom and lucide-react,
// copy this file next to it, fix the absolute paths below, then: npx vitest run
// Behaviour tests for the real App.jsx with supabaseClient/supabaseData mocked. NOT a live Supabase test.
import React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const fe = 'c:/Mohan/OFFICE SNACKS TRACKER/frontend/src';
const h = vi.hoisted(() => ({ profile: null, session: null }));

vi.mock('c:/Mohan/OFFICE SNACKS TRACKER/frontend/src/supabaseClient.js', () => {
  const supabase = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.session }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
      signInWithPassword: vi.fn(async ({ email }) => ({ data: { user: { id: 'u1', email } }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ error: null })),
    },
  };
  return { supabase, supabaseConfigError: '', loadCurrentProfile: vi.fn(async () => h.profile) };
});
vi.mock('c:/Mohan/OFFICE SNACKS TRACKER/frontend/src/supabaseData.js', () => ({
  api: vi.fn(async (path) => {
    if (path.includes('dashboard/summary')) return { employeeCount: 3, activeEmployeeCount: 3, activeSnackCount: 2, todayRecordCount: 0, todayQuantity: 0, morningBreak: {}, eveningBreak: {}, combinedBreak: {} };
    if (path === '/me') return h.profile.role === 'admin' ? null : { id: 1, name: 'Asha', active: true };
    return [];
  }),
  listUsers: vi.fn(async () => [{ user_id: 'u2', email: 'asha@x.com', role: 'user', employee_id: 1, employee_name: 'Asha', active: true, must_change_password: false, created_at: '2026-11-01T00:00:00Z', last_sign_in_at: null }]),
  adminUsers: vi.fn(async () => ({})),
  completePasswordChange: vi.fn(async () => {}),
}));

import App from 'c:/Mohan/OFFICE SNACKS TRACKER/frontend/src/App.jsx';
import { supabase, loadCurrentProfile } from 'c:/Mohan/OFFICE SNACKS TRACKER/frontend/src/supabaseClient.js';
import { completePasswordChange, api, listUsers, adminUsers } from 'c:/Mohan/OFFICE SNACKS TRACKER/frontend/src/supabaseData.js';

const defaultApi = api.getMockImplementation(), defaultListUsers = listUsers.getMockImplementation(), defaultAdminUsers = adminUsers.getMockImplementation();

const admin = { user_id: 'u1', role: 'admin', employee_id: null, active: true, must_change_password: false, displayName: '' };
const user = { user_id: 'u2', role: 'user', employee_id: 1, active: true, must_change_password: false, displayName: 'Asha' };
const navNames = () => within(document.querySelector('nav')).getAllByRole('button').map(b => b.textContent.trim());

async function signInAs(profile) {
  h.profile = profile; h.session = null;
  render(<App />);
  await screen.findByText('Sign in to record tea-break snacks.');
  fireEvent.change(document.querySelector('input[type=email]'), { target: { value: 'a@x.com' } });
  fireEvent.change(document.querySelector('input[type=password]'), { target: { value: 'whatever-123' } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}


beforeEach(() => { cleanup(); vi.clearAllMocks(); api.mockReset(); });
afterEach(() => cleanup());
const REC = (id, name, empId, snack, sid, qty, price) => ({ id, employeeId: empId, employeeName: name, snackId: sid, snackName: snack, quantity: qty, unitPrice: price, amount: price == null ? null : price * qty, takenAt: '2026-11-04T05:00:00Z', breakType: 'MORNING' });
function mockData(records, noSnacks = []) {
  api.mockImplementation(async (path) => {
    if (path.includes('dashboard/summary')) return { employeeCount: 1, activeEmployeeCount: 1, activeSnackCount: 1, todayRecordCount: 0, todayQuantity: 0, morningBreak: {}, eveningBreak: {}, combinedBreak: {} };
    if (path.startsWith('/records')) return records;
    if (path.startsWith('/no-snacks')) return noSnacks;
    if (path === '/me') return { id: 1, name: 'Asha', active: true };
    return [];
  });
}
async function openMonth(profile) {
  await signInAs(profile);
  await waitFor(() => { if (!document.querySelector('nav')) throw new Error('nav not ready'); });
  const nav = document.querySelector('nav');
  fireEvent.click(within(nav).getByRole('button', { name: /month records/i }));
  await screen.findByRole('combobox', { name: 'Report view' });
}

const ADMIN_ROWS = () => [REC(1, 'Asha', 1, 'Tea', 10, 2, 10), REC(2, 'Asha', 1, 'Samosa', 11, 3, 15.5), REC(3, 'Ravi', 2, 'Tea', 10, 1, 12)];
const NS = [{ id: 'ns-1', noSnacks: true, employeeId: 3, employeeName: 'Meena', snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null, takenAt: '2026-11-04T05:00:00Z', breakType: 'MORNING', day: '2026-11-04' }];

describe('Month Records: single report dropdown', () => {
  it('admin: one dropdown (Total Snacks List / User-wise List), old tabs and Total Amount report are gone, totals and CSV kept', async () => {
    mockData(ADMIN_ROWS(), NS);
    await openMonth(admin);
    const picker = screen.getByRole('combobox', { name: 'Report view' });
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Total Snacks List', 'User-wise List']);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByTitle('Refresh')).toBeNull(); // top-bar refresh icon removed
    expect(screen.queryByText('Total Amount Report')).toBeNull();
    expect(screen.getByText('Known amount')).toBeTruthy(); // existing monthly totals kept
    expect(screen.getByRole('button', { name: /download csv/i })).toBeTruthy();
    expect(document.querySelector('input[type=month]')).toBeTruthy(); // existing month filter kept
    // default = all snack records (table), user-wise hidden
    expect(screen.getAllByText('Asha').length).toBe(2);
    expect(screen.getByText('Ravi')).toBeTruthy();
    expect(screen.queryByText('Snack totals by employee')).toBeNull();
  });
  it('admin: User-wise List replaces the records table with one row per employee', async () => {
    mockData(ADMIN_ROWS(), NS);
    await openMonth(admin);
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'users' } });
    expect(screen.getByText('Snack totals by employee')).toBeTruthy();
    expect(screen.getAllByText('Asha').length).toBe(1);
    expect(screen.getByText('Ravi')).toBeTruthy();
    expect(screen.queryByText('RECORD')).toBeNull(); // the records table header is not shown
    expect(screen.getByText('6 total snacks')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'all' } });
    expect(screen.queryByText('Snack totals by employee')).toBeNull();
    expect(screen.getAllByText('Asha').length).toBe(2);
  });
  it('admin: User-wise List shows each employee total amount (saved price x quantity) and a grand total; No Snacks excluded', async () => {
    mockData([...ADMIN_ROWS(), REC(4, 'Ravi', 2, 'Vada', 12, 2, null)], NS);
    await openMonth(admin);
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'users' } });
    expect(screen.getByText('TOTAL AMOUNT')).toBeTruthy();
    // Asha: 2x10 + 3x15.5 = 66.50 ; Ravi: 1x12 = 12.00 (+1 record with no saved price) ; total 78.50
    expect(screen.getByText('₹66.50')).toBeTruthy();
    expect(screen.getAllByText('₹12.00').length).toBe(1);
    expect(screen.getByText('Total')).toBeTruthy(); // admin keeps the Total row
    expect(screen.getAllByText('₹78.50').length).toBe(2); // Known amount card + total row, same figure
    expect(screen.getAllByText(/\+1 no price/).length).toBe(2); // Ravi row + total row
    expect(screen.queryByText('Meena')).toBeNull();
  });
  it('admin: User-wise CSV / PDF buttons appear only while the User-wise List is selected; existing CSV and Invoice PDF stay', async () => {
    mockData(ADMIN_ROWS(), NS);
    await openMonth(admin);
    expect(screen.queryByRole('button', { name: /user-wise csv/i })).toBeNull(); // Total Snacks List view
    expect(screen.queryByRole('button', { name: /user-wise pdf/i })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'users' } });
    expect(screen.getByRole('button', { name: /user-wise csv/i }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /user-wise pdf/i }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /^download csv/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /download invoice pdf/i })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'all' } });
    expect(screen.queryByRole('button', { name: /user-wise csv/i })).toBeNull();
  });
  it('admin: User-wise download buttons are disabled for an empty month', async () => {
    mockData([]);
    await openMonth(admin);
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'users' } });
    expect(screen.getByRole('button', { name: /user-wise csv/i }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /user-wise pdf/i }).disabled).toBe(true);
  });
  it('user: never gets the User-wise download buttons', async () => {
    mockData([REC(1, 'Asha', 1, 'Tea', 10, 2, 10)]);
    await openMonth(user);
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'users' } });
    expect(screen.queryByRole('button', { name: /user-wise/i })).toBeNull();
  });
  it('user: gets the same dropdown over their own rows only', async () => {
    mockData([REC(1, 'Asha', 1, 'Tea', 10, 2, 10)]);
    await openMonth(user);
    const picker = screen.getByRole('combobox', { name: 'Report view' });
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Total Snacks List', 'User-wise List']);
    expect(screen.queryByText('Ravi')).toBeNull();
    fireEvent.change(picker, { target: { value: 'users' } });
    expect(screen.getByText('Snack totals by employee')).toBeTruthy();
    expect(screen.queryByText('Ravi')).toBeNull();
    expect(screen.getByText('TOTAL AMOUNT')).toBeTruthy(); // amount column shown
    expect(screen.queryByText('Total')).toBeNull(); // no Total row for a user
  });
  it('user: Custom dates lets them pick From/To and requests exactly that range; invalid ranges are rejected', async () => {
    mockData([REC(1, 'Asha', 1, 'Tea', 10, 2, 10)]);
    await openMonth(user);
    expect(screen.getByLabelText('Month')).toBeTruthy(); // default is still the month picker
    fireEvent.change(screen.getByRole('combobox', { name: 'Report period' }), { target: { value: 'custom' } });
    expect(screen.queryByLabelText('Month')).toBeNull();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-03' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-05' } });
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/records?from=2026-11-03&to=2026-11-05')).toBe(true));
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/no-snacks?from=2026-11-03&to=2026-11-05')).toBe(true));
    expect(screen.getByRole('heading', { name: /3 Nov 2026 . 5 Nov 2026/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /download csv/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Report view' })).toBeTruthy(); // report dropdown still works with a custom range
    // From after To -> error, no request for that range
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-10' } });
    expect(screen.getByText(/From must not be after To/)).toBeTruthy();
    expect(api.mock.calls.some((c) => c[0] === '/records?from=2026-11-10&to=2026-11-05')).toBe(false);
    // back to Month
    fireEvent.change(screen.getByRole('combobox', { name: 'Report period' }), { target: { value: 'month' } });
    expect(screen.getByLabelText('Month')).toBeTruthy();
  });
  it('admin: no Period control on Month Records (admins keep the month picker; custom ranges live on Reports)', async () => {
    mockData(ADMIN_ROWS(), NS);
    await openMonth(admin);
    expect(screen.queryByRole('combobox', { name: 'Report period' })).toBeNull();
    expect(screen.getByLabelText('Month')).toBeTruthy();
  });
  it('empty month: both views show an empty state, no crash', async () => {
    mockData([]);
    await openMonth(admin);
    expect(screen.getAllByText(/No records found for/i).length).toBeGreaterThanOrEqual(1);
    fireEvent.change(screen.getByRole('combobox', { name: 'Report view' }), { target: { value: 'users' } });
    expect(screen.getByText('Snack totals by employee')).toBeTruthy();
    expect(screen.getByText('No totals for these filters.')).toBeTruthy();
  });
});

describe('Snack History: user date range', () => {
  async function openHistory(profile) {
    await signInAs(profile);
    await waitFor(() => { if (!document.querySelector('nav')) throw new Error('nav not ready'); });
    fireEvent.click(within(document.querySelector('nav')).getByRole('button', { name: /snack history/i }));
    await screen.findByText(/Your own snack records|Filter by date and break/);
  }
  it('user: Period = Date range shows From/To and requests exactly that range; single date stays the default', async () => {
    mockData([REC(1, 'Asha', 1, 'Tea', 10, 2, 10)]);
    await openHistory(user);
    expect(screen.getByLabelText('Date')).toBeTruthy(); // default: single date
    expect(api.mock.calls.some((c) => /^\/records\?date=\d{4}-\d{2}-\d{2}/.test(c[0]))).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'History period' }), { target: { value: 'range' } });
    expect(screen.queryByLabelText('Date')).toBeNull();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-03' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-05' } });
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/records?from=2026-11-03&to=2026-11-05')).toBe(true));
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/no-snacks?from=2026-11-03&to=2026-11-05')).toBe(true));
    // invalid: From after To -> error, nothing requested for it
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-10' } });
    await screen.findByText(/From must not be after To/);
    expect(api.mock.calls.some((c) => c[0] === '/records?from=2026-11-10&to=2026-11-05')).toBe(false);
    // back to a single date
    fireEvent.change(screen.getByRole('combobox', { name: 'History period' }), { target: { value: 'single' } });
    expect(screen.getByLabelText('Date')).toBeTruthy();
  });
  it('admin: Snack History keeps the single Date filter (no Period control)', async () => {
    mockData(ADMIN_ROWS(), NS);
    await signInAs(admin);
    await waitFor(() => { if (!document.querySelector('nav')) throw new Error('nav not ready'); });
    fireEvent.click(within(document.querySelector('nav')).getByRole('button', { name: /snack history/i }));
    await screen.findByLabelText('Date');
    expect(screen.queryByRole('combobox', { name: 'History period' })).toBeNull();
  });
});
