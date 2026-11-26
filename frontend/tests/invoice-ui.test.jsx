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
  await screen.findByRole('tab', { name: 'Total Amount Report' });
}

describe('Total Amount Report', () => {
  it('admin: CSV stays, new tab + PDF buttons exist, totals use saved prices and exclude No Snacks', async () => {
    mockData([REC(1, 'Asha', 1, 'Tea', 10, 2, 10), REC(2, 'Asha', 1, 'Samosa', 11, 3, 15.5), REC(3, 'Ravi', 2, 'Tea', 10, 1, 12)], [{ id: 'ns-1', noSnacks: true, employeeId: 3, employeeName: 'Meena', snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null, takenAt: '2026-11-04T05:00:00Z', breakType: 'MORNING', day: '2026-11-04' }]);
    await openMonth(admin);
    expect(screen.getByRole('button', { name: /download csv/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /download invoice pdf/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Monthly Records' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Total Amount Report' }));
    const inv = await screen.findByTestId('invoice-report');
    expect(within(inv).getByText('MONTHLY SNACK EXPENSE REPORT')).toBeTruthy();
    expect(within(inv).getAllByText('₹ 78.50').length).toBeGreaterThanOrEqual(2); // summary card + grand total
    expect(within(inv).getAllByText('Asha').length).toBe(3); // 2 detail lines + 1 employee summary row
    expect(within(inv).queryByText('Meena')).toBeNull();
    expect(within(inv).getByText('₹ 66.50')).toBeTruthy(); // Asha total
  });
  it('user: sees only the rows the API returns for them', async () => {
    mockData([REC(1, 'Asha', 1, 'Tea', 10, 2, 10)]);
    await openMonth(user);
    fireEvent.click(screen.getByRole('tab', { name: 'Total Amount Report' }));
    const inv = await screen.findByTestId('invoice-report');
    expect(within(inv).queryByText('Ravi')).toBeNull();
    expect(within(inv).getAllByText('₹ 20.00').length).toBeGreaterThanOrEqual(2);
  });
  it('empty month shows zero totals and an empty state', async () => {
    mockData([]);
    await openMonth(admin);
    fireEvent.click(screen.getByRole('tab', { name: 'Total Amount Report' }));
    const inv = await screen.findByTestId('invoice-report');
    expect(within(inv).getAllByText('₹ 0.00').length).toBeGreaterThanOrEqual(2);
    expect(within(inv).getAllByText(/Nothing recorded/i).length).toBeGreaterThanOrEqual(1);
  });
});
