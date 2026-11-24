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

beforeEach(() => { cleanup(); vi.clearAllMocks(); api.mockReset(); api.mockImplementation(defaultApi); listUsers.mockReset(); listUsers.mockImplementation(defaultListUsers); adminUsers.mockReset(); adminUsers.mockImplementation(defaultAdminUsers); window.history.replaceState({}, '', '/'); });

describe('ADMIN', () => {
  it('sees all 8 menu items including User Management, name/role badge, and can open User Management', async () => {
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('User Management'));
    expect(navNames()).toEqual(['Dashboard', 'Take Snacks', 'Employees', 'Snacks', 'Snack History', 'Reports', 'Month Records', 'User Management']);
    expect(document.querySelector('.user-badge').textContent).toContain('ADMIN');
    fireEvent.click(within(document.querySelector('nav')).getByText('User Management'));
    await screen.findByText('User accounts');
    expect(screen.getByText('asha@x.com')).toBeTruthy();
    expect(screen.getByText('Edit email')).toBeTruthy();
    expect(screen.getByText('Reset password')).toBeTruthy();
    expect(screen.getByText('Deactivate')).toBeTruthy();
  });
});

describe('USER', () => {
  it('sees only Dashboard / Take Snacks / Snack History, with their name and role USER', async () => {
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBeGreaterThan(0));
    expect(navNames()).toEqual(['Dashboard', 'Take Snacks', 'Snack History']);
    const badge = document.querySelector('.user-badge').textContent;
    expect(badge).toContain('Asha'); expect(badge).toContain('USER'); expect(badge).not.toContain('ADMIN');
    expect(screen.queryByText('User Management')).toBeNull();
  });
  it('dashboard shows "My records" instead of the company-wide employee count', async () => {
    await signInAs(user);
    await screen.findByText('My records');
    expect(screen.queryByText('Total employees')).toBeNull();
  });
  it('Snack History has Edit (own rows) but no Delete/CSV/PDF controls, and Update saves via PUT without a break type', async () => {
    const rec = { id: 7, employeeId: 1, employeeName: 'Asha', snackId: 1, snackName: 'Tea', quantity: 2, breakType: 'MORNING', unitPrice: 10, amount: 20, takenAt: new Date().toISOString() };
    api.mockImplementation(async (path, opts) => {
      if (path.startsWith('/records') && opts?.method === 'PUT') return { ...rec, ...JSON.parse(opts.body) };
      if (path.startsWith('/records')) return [rec];
      if (path === '/snacks') return [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }, { id: 2, name: 'Biscuit', active: true, unitPrice: 25 }];
      if (path === '/employees') return [{ id: 1, name: 'Asha', active: true }];
      return defaultApi(path, opts);
    });
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(3));
    fireEvent.click(within(document.querySelector('nav')).getByText('Snack History'));
    await screen.findByText('Snack records');
    expect(screen.queryByText('Export CSV')).toBeNull();
    expect(screen.queryByText('Download PDF')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const modal = document.querySelector('.edit-modal');
    expect(modal.querySelector('select').value).toBe('1');
    expect(modal.querySelector('input[type=number]').value).toBe('2');
    expect(within(modal).queryByText('Break type')).toBeNull();
    fireEvent.change(modal.querySelector('select'), { target: { value: '2' } });
    fireEvent.change(modal.querySelector('input[type=number]'), { target: { value: '3' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await screen.findByText('Snack record updated.');
    const put = api.mock.calls.find(c => c[1]?.method === 'PUT');
    expect(put[0]).toBe('/records/7');
    expect(JSON.parse(put[1].body)).toEqual({ employeeId: 1, snackId: 2, quantity: 3 });
    expect(api.mock.calls.filter(c => c[1]?.method === 'POST').length).toBe(0);
  });
  it('the ?view=report deep link does not open Reports for a USER', async () => {
    window.history.replaceState({}, '', '/?view=report');
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(3));
    expect(document.querySelector('.crumb + .slash + b').textContent).toBe('Dashboard');
  });
});

describe('First-login password change', () => {
  const pending = { ...user, must_change_password: true };
  it('shows the change-password screen instead of the app', async () => {
    await signInAs(pending);
    await screen.findByText('Set a new password');
    expect(document.querySelector('nav')).toBeNull();
  });
  it('rejects mismatched / short passwords without calling Supabase', async () => {
    await signInAs(pending); await screen.findByText('Set a new password');
    const [p1, p2] = document.querySelectorAll('input[type=password]');
    fireEvent.change(p1, { target: { value: 'abcdefghij1' } }); fireEvent.change(p2, { target: { value: 'different-123' } });
    fireEvent.submit(document.querySelector('form'));
    await screen.findByText('The two passwords do not match.');
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });
  it('changes the password, clears the flag, and opens the app', async () => {
    await signInAs(pending); await screen.findByText('Set a new password');
    h.profile = user; // what the database returns after complete_password_change()
    const [p1, p2] = document.querySelectorAll('input[type=password]');
    fireEvent.change(p1, { target: { value: 'My-new-pass-42' } }); fireEvent.change(p2, { target: { value: 'My-new-pass-42' } });
    fireEvent.submit(document.querySelector('form'));
    await waitFor(() => expect(navNames()).toEqual(['Dashboard', 'Take Snacks', 'Snack History']));
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'My-new-pass-42' });
    expect(completePasswordChange).toHaveBeenCalledTimes(1);
  });
  it('a retry after "same password" still completes (no lock-out)', async () => {
    await signInAs(pending); await screen.findByText('Set a new password');
    supabase.auth.updateUser.mockResolvedValueOnce({ error: { code: 'same_password', message: 'New password should be different' } });
    h.profile = user;
    const [p1, p2] = document.querySelectorAll('input[type=password]');
    fireEvent.change(p1, { target: { value: 'My-new-pass-42' } }); fireEvent.change(p2, { target: { value: 'My-new-pass-42' } });
    fireEvent.submit(document.querySelector('form'));
    await waitFor(() => expect(completePasswordChange).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navNames().length).toBe(3));
  });
  it('a real update error is shown and the flag is NOT cleared', async () => {
    await signInAs(pending); await screen.findByText('Set a new password');
    supabase.auth.updateUser.mockResolvedValueOnce({ error: { code: 'weak_password', message: 'Password is too weak' } });
    const [p1, p2] = document.querySelectorAll('input[type=password]');
    fireEvent.change(p1, { target: { value: 'My-new-pass-42' } }); fireEvent.change(p2, { target: { value: 'My-new-pass-42' } });
    fireEvent.submit(document.querySelector('form'));
    await screen.findByText('Password is too weak');
    expect(completePasswordChange).not.toHaveBeenCalled();
  });
});

describe('Deactivated account', () => {
  it('is signed out at login and sees an explanation; never reaches the app', async () => {
    await signInAs({ ...user, active: false });
    await screen.findByText(/has been deactivated/i);
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(document.querySelector('nav')).toBeNull();
  });
  it('is signed out on session restore too', async () => {
    h.profile = { ...user, active: false }; h.session = { user: { id: 'u2', email: 'a@x.com' } };
    render(<App />);
    await screen.findByText(/has been deactivated/i);
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(document.querySelector('nav')).toBeNull();
  });
});

describe('Sign out', () => {
  it('returns to the login screen', async () => {
    await signInAs(admin);
    await waitFor(() => expect(navNames().length).toBe(8));
    fireEvent.click(screen.getByTitle('Sign out'));
    await screen.findByText('Sign in to record tea-break snacks.');
    expect(supabase.auth.signOut).toHaveBeenCalled();
  });
});

const openUserManagement = async () => {
  await signInAs(admin);
  await waitFor(() => expect(navNames()).toContain('User Management'));
  fireEvent.click(within(document.querySelector('nav')).getByText('User Management'));
  await screen.findByText('User accounts');
};
const firstOption = () => document.querySelector('.add-form select option').textContent;
const withEmployees = list => api.mockImplementation(async path => path === '/employees' ? list : defaultApi(path));

describe('User Management: failure and empty states', () => {
  const NOT_INSTALLED = 'User management is not installed. Run database/migrations/2026-11-23-two-role-user-management.sql in the Supabase SQL Editor.';
  it('user list fails to load: its message is shown as-is (no unrelated suffix, no doubled period)', async () => {
    listUsers.mockRejectedValue(new Error(NOT_INSTALLED));
    await openUserManagement();
    const box = await waitFor(() => { const b = document.querySelector('.error-box'); expect(b).not.toBeNull(); return b; });
    expect(box.textContent).toBe(NOT_INSTALLED);
    expect(box.textContent).not.toMatch(/Check Supabase sign-in and access policies/);
    expect(box.textContent).not.toMatch(/\.\./);
  });
  it('user list fails to load: the employee dropdown says so honestly instead of "All active employees already have a login"', async () => {
    withEmployees([{ id: 1, name: 'Asha', active: true }]);
    listUsers.mockRejectedValue(new Error(NOT_INSTALLED));
    await openUserManagement();
    await waitFor(() => expect(firstOption()).toMatch(/Could not load the user list/));
    expect(firstOption()).not.toMatch(/already have a login/);
    expect(screen.getByRole('button', { name: /create user/i }).disabled).toBe(true);
  });
  it('healthy: employees without a login are offered, no error box, no failure message', async () => {
    withEmployees([{ id: 1, name: 'Asha', active: true }, { id: 2, name: 'Ravi', active: true }]);
    listUsers.mockResolvedValue([]);
    await openUserManagement();
    await waitFor(() => expect(firstOption()).toBe('Choose an employee'));
    expect([...document.querySelectorAll('.add-form select option')].map(o => o.textContent)).toEqual(['Choose an employee', 'Asha', 'Ravi']);
    expect(document.querySelector('.error-box')).toBeNull();
  });
  it('healthy: when every active employee already has a login, the ORIGINAL message is kept', async () => {
    withEmployees([{ id: 1, name: 'Asha', active: true }]);
    listUsers.mockResolvedValue([{ user_id: 'u2', email: 'asha@x.com', role: 'user', employee_id: 1, employee_name: 'Asha', active: true, must_change_password: false, created_at: '2026-11-01T00:00:00Z', last_sign_in_at: null }]);
    await openUserManagement();
    await waitFor(() => expect(firstOption()).toBe('All active employees already have a login'));
    expect(document.querySelector('.error-box')).toBeNull();
  });
  it('a stale-but-present employee list is still usable if a later refresh fails (message only replaces an EMPTY list)', async () => {
    withEmployees([{ id: 1, name: 'Asha', active: true }]);
    listUsers.mockResolvedValueOnce([]);
    await openUserManagement();
    await waitFor(() => expect(firstOption()).toBe('Choose an employee'));
    listUsers.mockRejectedValue(new Error('network down'));
    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(document.querySelector('.error-box')).not.toBeNull());
    expect(firstOption()).toBe('Choose an employee');
  });
});

describe('The shared error box is unchanged for every other page', () => {
  it('Dashboard errors still carry the "Check Supabase sign-in and access policies" hint', async () => {
    api.mockRejectedValue(new Error('boom'));   // persistent: sign-in triggers a second Dashboard load that would otherwise clear the first error
    await signInAs(admin);
    const box = await waitFor(() => { const b = document.querySelector('.error-box'); expect(b).not.toBeNull(); return b; });
    expect(box.textContent).toBe('boom. Check Supabase sign-in and access policies.');
  });
});

// ---------------------------------------------------------------- Edit password (admin sets a user's password directly)
const ROWS = [
  { user_id: 'u1', email: 'amohan@x.com', role: 'admin', employee_id: null, employee_name: null, active: true, must_change_password: false, created_at: '2026-11-01T00:00:00Z', last_sign_in_at: null },
  { user_id: 'u2', email: 'asha@x.com', role: 'user', employee_id: 1, employee_name: 'Asha', active: true, must_change_password: false, created_at: '2026-11-02T00:00:00Z', last_sign_in_at: null },
];
const GOOD = 'Correct-Horse-42';
const userRow = () => screen.getByText('asha@x.com').closest('tr');
const rowButtons = row => within(row).queryAllByRole('button').map(b => b.textContent.trim());
const openEditPassword = async () => {
  listUsers.mockResolvedValue(ROWS);
  await openUserManagement();
  await screen.findByText('asha@x.com');
  fireEvent.click(within(userRow()).getByRole('button', { name: 'Edit password' }));
  return document.querySelector('.edit-modal');
};
const pwInputs = () => [...document.querySelectorAll('.edit-modal input[type=password]')];
const fillPw = (a, b) => { const [i1, i2] = pwInputs(); fireEvent.change(i1, { target: { value: a } }); fireEvent.change(i2, { target: { value: b } }); };
const submitPw = () => fireEvent.submit(document.querySelector('.edit-modal'));
const toastText = () => document.querySelector('.toast')?.textContent || '';

describe('User Management: Edit password', () => {
  it('every USER row has an "Edit password" action; the ADMIN row has no actions at all', async () => {
    listUsers.mockResolvedValue(ROWS); await openUserManagement(); await screen.findByText('asha@x.com');
    expect(rowButtons(userRow())).toContain('Edit password');
    expect(rowButtons(screen.getByText('amohan@x.com').closest('tr'))).toEqual([]);
  });
  it('the existing actions are all still there, in addition to the new one', async () => {
    listUsers.mockResolvedValue(ROWS); await openUserManagement(); await screen.findByText('asha@x.com');
    expect(rowButtons(userRow())).toEqual(['Edit email', 'Edit password', 'Deactivate', 'Reset password']);
  });
  it('opens a dialog with New password and Confirm password fields (masked, new-password autocomplete), both empty, and never shows a current password', async () => {
    const modal = await openEditPassword();
    expect(modal.textContent).toMatch(/Edit password/); expect(modal.textContent).toMatch(/New password/); expect(modal.textContent).toMatch(/Confirm password/);
    expect(modal.textContent).toMatch(/current password is never shown/i);
    const inputs = pwInputs(); expect(inputs).toHaveLength(2);
    inputs.forEach(i => { expect(i.type).toBe('password'); expect(i.getAttribute('autocomplete')).toBe('new-password'); expect(i.value).toBe(''); });
  });
  it('mismatched passwords: shows an error, does NOT call the server, keeps the dialog open', async () => {
    await openEditPassword(); fillPw(GOOD, GOOD + 'x'); submitPw();
    await screen.findByText('The two passwords do not match.');
    expect(adminUsers).not.toHaveBeenCalled(); expect(document.querySelector('.edit-modal')).not.toBeNull();
  });
  it('requirements: shorter than 10 characters is rejected locally', async () => {
    await openEditPassword(); fillPw('short1', 'short1'); submitPw();
    await screen.findByText('The password must be at least 10 characters.'); expect(adminUsers).not.toHaveBeenCalled();
  });
  it('requirements: more than 72 BYTES is rejected locally (37 accented characters = 74 bytes)', async () => {
    const long = 'é'.repeat(37); await openEditPassword(); fillPw(long, long); submitPw();
    await screen.findByText('The password is too long (72 bytes at most).'); expect(adminUsers).not.toHaveBeenCalled();
  });
  it('requirements: blank / whitespace-only is rejected locally; exactly 72 bytes is accepted', async () => {
    await openEditPassword(); fillPw('          ', '          '); submitPw();
    await screen.findByText('Enter a new password.'); expect(adminUsers).not.toHaveBeenCalled();
    const edge = 'a'.repeat(72); fillPw(edge, edge); submitPw();
    await waitFor(() => expect(adminUsers).toHaveBeenCalledTimes(1));
  });
  it('success: calls the existing server action exactly once with the user id and the typed password, shows a success message, closes the dialog', async () => {
    await openEditPassword(); fillPw(GOOD, GOOD); submitPw();
    await waitFor(() => expect(adminUsers).toHaveBeenCalledTimes(1));
    expect(adminUsers).toHaveBeenCalledWith('reset-password', { userId: 'u2', password: GOOD });
    await waitFor(() => expect(toastText()).toMatch(/Password updated for Asha\. They must choose a new password at next sign-in\./));
    await waitFor(() => expect(document.querySelector('.edit-modal')).toBeNull());
  });
  it('success: the password is not displayed anywhere afterwards, and the fields are empty when reopened', async () => {
    await openEditPassword(); fillPw(GOOD, GOOD); submitPw();
    await waitFor(() => expect(document.querySelector('.edit-modal')).toBeNull());
    expect(document.body.textContent).not.toContain(GOOD);
    expect([...document.querySelectorAll('input')].some(i => i.value === GOOD)).toBe(false);
    expect(document.querySelector('.modal-backdrop')).toBeNull();            // no credentials dialog: the password is not echoed back
    fireEvent.click(within(userRow()).getByRole('button', { name: 'Edit password' }));
    expect(pwInputs().map(i => i.value)).toEqual(['', '']);
  });
  it('success: the user list is reloaded', async () => {
    await openEditPassword(); const before = listUsers.mock.calls.length; fillPw(GOOD, GOOD); submitPw();
    await waitFor(() => expect(listUsers.mock.calls.length).toBeGreaterThan(before));
  });
  it('server error: the real message is shown in the dialog and as a toast; no success message; the dialog stays open', async () => {
    adminUsers.mockRejectedValue(new Error('Resetting the password failed: Password is known to be weak'));
    await openEditPassword(); fillPw(GOOD, GOOD); submitPw();
    await waitFor(() => expect(document.querySelector('.edit-modal .error-box')?.textContent).toBe('Resetting the password failed: Password is known to be weak'));
    expect(toastText()).toMatch(/known to be weak/); expect(toastText()).not.toMatch(/Password updated/);
    expect(document.querySelector('.edit-modal')).not.toBeNull();
  });
  it('function not deployed: the clear "not deployed" message is shown (no fake success)', async () => {
    adminUsers.mockRejectedValue(new Error('The admin-users Edge Function is not deployed in this Supabase project.'));
    await openEditPassword(); fillPw(GOOD, GOOD); submitPw();
    await waitFor(() => expect(document.querySelector('.edit-modal .error-box')?.textContent).toMatch(/not deployed/));
    expect(toastText()).not.toMatch(/Password updated/);
  });
  it('Cancel closes the dialog without calling the server, and clears what was typed', async () => {
    await openEditPassword(); fillPw(GOOD, GOOD);
    fireEvent.click(within(document.querySelector('.edit-modal')).getByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('.edit-modal')).toBeNull(); expect(adminUsers).not.toHaveBeenCalled();
    fireEvent.click(within(userRow()).getByRole('button', { name: 'Edit password' }));
    expect(pwInputs().map(i => i.value)).toEqual(['', '']);
  });
});

describe('User Management: existing actions are unchanged', () => {
  it('Reset password still generates a temporary password and shows it once', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    listUsers.mockResolvedValue(ROWS); await openUserManagement(); await screen.findByText('asha@x.com');
    fireEvent.click(within(userRow()).getByRole('button', { name: 'Reset password' }));
    await waitFor(() => expect(adminUsers).toHaveBeenCalledTimes(1));
    const [action, payload] = adminUsers.mock.calls[0];
    expect(action).toBe('reset-password'); expect(payload.userId).toBe('u2'); expect(payload.password).toHaveLength(14);
    await screen.findByText('Password reset');
    spy.mockRestore();
  });
  it('Edit email still opens its own dialog; Deactivate still calls set-active', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    listUsers.mockResolvedValue(ROWS); await openUserManagement(); await screen.findByText('asha@x.com');
    fireEvent.click(within(userRow()).getByRole('button', { name: 'Edit email' }));
    expect(document.querySelector('.edit-modal h2').textContent).toBe('Edit user');
    fireEvent.click(within(document.querySelector('.edit-modal')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(userRow()).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(adminUsers).toHaveBeenCalledWith('set-active', { userId: 'u2', active: false }));
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------- Create User: password visibility toggle, readable email column, one-time password
const createPwInput = () => document.querySelector('.add-form .password-field input');
const eyeBtn = () => document.querySelector('.add-form .eye-btn');
const openCreateForm = async (users = []) => {
  withEmployees([{ id: 1, name: 'Asha', active: true }]);
  listUsers.mockResolvedValue(users);
  await openUserManagement();
  if (users.length) await screen.findByText(users[users.length - 1].email);   // the list has loaded
  else await waitFor(() => expect(firstOption()).toBe('Choose an employee'));
};

describe('Create User: show / hide password', () => {
  it('the temporary password is MASKED by default and the field blocks browser autofill of saved logins', async () => {
    await openCreateForm();
    const input = createPwInput();
    expect(input.type).toBe('password'); expect(input.getAttribute('autocomplete')).toBe('new-password'); expect(input.value).toHaveLength(14);
  });
  it('an eye button sits next to the field: a real icon, an accessible name, not a submit button', async () => {
    await openCreateForm();
    const b = eyeBtn();
    expect(b).not.toBeNull(); expect(b.type).toBe('button'); expect(b.getAttribute('aria-label')).toBe('Show password'); expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.querySelector('svg')).not.toBeNull(); expect(b.closest('.password-field').contains(createPwInput())).toBe(true);
  });
  it('clicking the eye shows the password, clicking again hides it; the value never changes and the icon/label swap', async () => {
    await openCreateForm();
    const value = createPwInput().value, hiddenIcon = eyeBtn().innerHTML;
    fireEvent.click(eyeBtn());
    expect(createPwInput().type).toBe('text'); expect(createPwInput().value).toBe(value);
    expect(eyeBtn().getAttribute('aria-label')).toBe('Hide password'); expect(eyeBtn().getAttribute('aria-pressed')).toBe('true'); expect(eyeBtn().innerHTML).not.toBe(hiddenIcon);
    fireEvent.click(eyeBtn());
    expect(createPwInput().type).toBe('password'); expect(createPwInput().value).toBe(value);
    expect(eyeBtn().getAttribute('aria-label')).toBe('Show password'); expect(eyeBtn().innerHTML).toBe(hiddenIcon);
  });
  it('clicking the eye does not submit the form or call the server', async () => {
    await openCreateForm(); fireEvent.click(eyeBtn()); fireEvent.click(eyeBtn());
    expect(adminUsers).not.toHaveBeenCalled();
  });
  it('Generate still makes a new 14-character password and keeps the current show/hide mode', async () => {
    await openCreateForm(); const first = createPwInput().value;
    fireEvent.click(eyeBtn());
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    expect(createPwInput().value).not.toBe(first); expect(createPwInput().value).toHaveLength(14); expect(createPwInput().type).toBe('text');
  });
  it('the admin can type their own temporary password with the eye on or off', async () => {
    await openCreateForm(); fireEvent.change(createPwInput(), { target: { value: 'Typed-By-Admin-9' } });
    expect(createPwInput().value).toBe('Typed-By-Admin-9'); fireEvent.click(eyeBtn()); expect(createPwInput().value).toBe('Typed-By-Admin-9');
  });
});

describe('Create User: the temporary password is shown only during creation', () => {
  const create = async () => {
    await openCreateForm(); fireEvent.click(eyeBtn());
    const pw = createPwInput().value;
    fireEvent.change(document.querySelector('.add-form select'), { target: { value: '1' } });
    fireEvent.change(document.querySelector('.add-form input[type=email]'), { target: { value: ' New.User@X.com ' } });
    fireEvent.submit(document.querySelector('.add-form'));
    await screen.findByText('Account created');
    return pw;
  };
  it('creating a user sends the typed values once and then reveals the password ONCE in the credentials dialog', async () => {
    const pw = await create();
    expect(adminUsers).toHaveBeenCalledTimes(1);
    expect(adminUsers).toHaveBeenCalledWith('create', { employeeId: 1, email: 'new.user@x.com', password: pw });
    const dialog = document.querySelector('.modal-backdrop .edit-modal');
    expect([...dialog.querySelectorAll('input')].map(i => i.value)).toEqual(['new.user@x.com', pw]);
    expect([...dialog.querySelectorAll('input')].every(i => i.readOnly)).toBe(true);
    expect(dialog.textContent).toMatch(/shown only now/i);
  });
  it('after "Done" the password is gone from the page, and the form starts again hidden with a NEW password', async () => {
    const pw = await create();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.querySelector('.modal-backdrop')).toBeNull();
    expect(document.body.textContent).not.toContain(pw);
    expect([...document.querySelectorAll('input')].some(i => i.value === pw)).toBe(false);
    expect(createPwInput().type).toBe('password'); expect(createPwInput().value).not.toBe(pw); expect(createPwInput().value).toHaveLength(14);
  });
  it('existing users: no password is shown or retrievable (a PASSWORD column exists, but no reveal control without a remembered temporary password)', async () => {
    await openCreateForm(ROWS);
    await screen.findByText('asha@x.com');
    const heads = [...document.querySelectorAll('thead th')].map(th => th.textContent.trim());
    expect(heads).toEqual(['EMPLOYEE', 'EMAIL', 'PASSWORD', 'ROLE', 'STATUS', 'CREATED', 'LAST LOGIN', 'ACTIONS']);
    expect(document.querySelectorAll('tbody .eye-btn, tbody .reveal-btn')).toHaveLength(0);
    expect(rowButtons(userRow())).toEqual(['Edit email', 'Edit password', 'Deactivate', 'Reset password']);   // Reset password is retained
  });
});

describe('User table: the email is clearly displayed', () => {
  it('every account shows its email in a dedicated, bold, selectable element with the full address as a tooltip', async () => {
    await openCreateForm(ROWS);
    await screen.findByText('asha@x.com');
    const emails = [...document.querySelectorAll('tbody .user-email')];
    expect(emails.map(e => e.textContent)).toEqual(['amohan@x.com', 'asha@x.com']);
    expect(emails.map(e => e.getAttribute('title'))).toEqual(['amohan@x.com', 'asha@x.com']);
    expect(emails.every(e => e.closest('td') === e.closest('tr').children[1])).toBe(true);   // always the EMAIL column
  });
  it('a long email address is kept whole (not truncated) in the DOM', async () => {
    const long = 'a.very.long.employee.name.with.many.parts@subdomain.opalminds-example.co.in';
    listUsers.mockResolvedValue([{ ...ROWS[1], email: long }]); withEmployees([]);
    await openUserManagement(); await screen.findByText(long);
    expect(document.querySelector('tbody .user-email').textContent).toBe(long);
  });
});

// ---------------------------------------------------------------- PASSWORD column: in-session temporary passwords, per-user eye, 60 s auto-hide, 15 min cleanup
const PW_A = 'Alpha-Secret-101', PW_B = 'Bravo-Secret-202';
const NOT_RETRIEVABLE = /cannot be retrieved/;
const pending = (id, email, name, empId) => ({ user_id: id, email, role: 'user', employee_id: empId, employee_name: name, active: true, must_change_password: true, created_at: '2026-11-23T00:00:00Z', last_sign_in_at: null });
const rowOf = email => screen.getByText(email).closest('tr');
const eyeOf = email => within(rowOf(email)).queryByRole('button', { name: /temporary password for/i });
const passwordCellOf = email => rowOf(email).querySelector('.pw-cell');
const tick = async ms => { await act(async () => { vi.advanceTimersByTime(ms); }); };
const startPasswordPage = async () => {
  withEmployees([{ id: 1, name: 'Asha', active: true }, { id: 2, name: 'Ravi', active: true }, { id: 3, name: 'Meena', active: true }]);
  listUsers.mockResolvedValue([ROWS[0]]);
  await openUserManagement();
  await waitFor(() => expect(firstOption()).toBe('Choose an employee'));
};
// create through the real form; the server then lists the given rows (all pending a first-login change)
const createVia = async ({ id, empId, email, pw, rowsAfter }) => {
  adminUsers.mockResolvedValueOnce({ userId: id, email });
  listUsers.mockResolvedValue([ROWS[0], ...rowsAfter]);
  fireEvent.change(document.querySelector('.add-form select'), { target: { value: String(empId) } });
  fireEvent.change(document.querySelector('.add-form input[type=email]'), { target: { value: email } });
  fireEvent.change(createPwInput(), { target: { value: pw } });
  fireEvent.submit(document.querySelector('.add-form'));
  await screen.findByText('Account created');
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await screen.findByText(email);
};
const U1 = pending('n1', 'asha@x.com', 'Asha', 1), U2 = pending('n2', 'ravi@x.com', 'Ravi', 2);
const createFirst = async () => { await startPasswordPage(); await createVia({ id: 'n1', empId: 1, email: 'asha@x.com', pw: PW_A, rowsAfter: [U1] }); };
const createSecond = async () => createVia({ id: 'n2', empId: 2, email: 'ravi@x.com', pw: PW_B, rowsAfter: [U1, U2] });

describe('PASSWORD column: temporary passwords set in this session', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a newly created user gets a masked Password cell with an eye; the real password is NOT in the page while hidden', async () => {
    await createFirst();
    expect(passwordCellOf('asha@x.com').textContent).toBe('••••••••');
    expect(eyeOf('asha@x.com')).not.toBeNull();
    expect(document.body.textContent).not.toContain(PW_A); expect(document.body.innerHTML).not.toContain(PW_A);
  });
  it('the mask has a fixed length, so it does not reveal how long the password is', async () => {
    await createFirst(); const a = passwordCellOf('asha@x.com').textContent;
    await createSecond(); expect(passwordCellOf('ravi@x.com').textContent).toBe(a);
  });
  it('the eye is a real icon button with an accessible name that includes the employee, and it never submits or calls the server', async () => {
    await createFirst(); const calls = adminUsers.mock.calls.length; const b = eyeOf('asha@x.com');
    expect(b.type).toBe('button'); expect(b.getAttribute('aria-label')).toBe('Show temporary password for Asha'); expect(b.getAttribute('aria-pressed')).toBe('false'); expect(b.querySelector('svg')).not.toBeNull();
    fireEvent.click(b); fireEvent.click(b);
    expect(adminUsers.mock.calls.length).toBe(calls);
  });
  it('clicking the eye shows that password; clicking again hides it and removes it from the page', async () => {
    await createFirst();
    fireEvent.click(eyeOf('asha@x.com'));
    expect(passwordCellOf('asha@x.com').textContent).toBe(PW_A);
    expect(eyeOf('asha@x.com').getAttribute('aria-label')).toBe('Hide temporary password for Asha'); expect(eyeOf('asha@x.com').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(eyeOf('asha@x.com'));
    expect(passwordCellOf('asha@x.com').textContent).toBe('••••••••');
    expect(document.body.textContent).not.toContain(PW_A); expect(document.body.innerHTML).not.toContain(PW_A);
  });
  it('each user\'s eye is INDEPENDENT: revealing or hiding one never changes another', async () => {
    await createFirst(); await createSecond();
    fireEvent.click(eyeOf('asha@x.com'));
    expect(passwordCellOf('asha@x.com').textContent).toBe(PW_A); expect(passwordCellOf('ravi@x.com').textContent).toBe('••••••••'); expect(document.body.textContent).not.toContain(PW_B);
    fireEvent.click(eyeOf('ravi@x.com'));
    expect(passwordCellOf('asha@x.com').textContent).toBe(PW_A); expect(passwordCellOf('ravi@x.com').textContent).toBe(PW_B);
    fireEvent.click(eyeOf('asha@x.com'));
    expect(passwordCellOf('asha@x.com').textContent).toBe('••••••••'); expect(passwordCellOf('ravi@x.com').textContent).toBe(PW_B);
    expect(document.body.textContent).not.toContain(PW_A);
  });

  it('AUTO-HIDE: a revealed password hides itself after 60 seconds (still there at 59 s) and leaves the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await createFirst(); fireEvent.click(eyeOf('asha@x.com'));
    await tick(59000); expect(passwordCellOf('asha@x.com').textContent).toBe(PW_A);
    await tick(1000);  expect(passwordCellOf('asha@x.com').textContent).toBe('••••••••');
    expect(document.body.textContent).not.toContain(PW_A); expect(eyeOf('asha@x.com')).not.toBeNull();   // hidden, not forgotten
    fireEvent.click(eyeOf('asha@x.com')); expect(passwordCellOf('asha@x.com').textContent).toBe(PW_A);   // can be revealed again
  });
  it('AUTO-HIDE timers are independent per user (A at t0, B at +30 s: A hides at 60 s, B at 90 s)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await createFirst(); await createSecond();
    fireEvent.click(eyeOf('asha@x.com')); await tick(30000); fireEvent.click(eyeOf('ravi@x.com'));
    await tick(30000);
    expect(passwordCellOf('asha@x.com').textContent).toBe('••••••••'); expect(passwordCellOf('ravi@x.com').textContent).toBe(PW_B);
    await tick(29000); expect(passwordCellOf('ravi@x.com').textContent).toBe(PW_B);
    await tick(1000);  expect(passwordCellOf('ravi@x.com').textContent).toBe('••••••••');
  });
  it('AUTO-HIDE counts from the LATEST reveal: hide + re-reveal restarts the 60 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await createFirst(); fireEvent.click(eyeOf('asha@x.com')); await tick(40000);
    fireEvent.click(eyeOf('asha@x.com')); fireEvent.click(eyeOf('asha@x.com'));          // hide, then show again at t=40 s
    await tick(59000); expect(passwordCellOf('asha@x.com').textContent).toBe(PW_A);      // t=99 s: the OLD timer would have fired at 60 s
    await tick(1000);  expect(passwordCellOf('asha@x.com').textContent).toBe('••••••••');
  });
  it('MEMORY CLEANUP: after 15 minutes the password is forgotten (still there at 14:59): no eye, "Hidden" with the explanation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await createFirst();
    await tick(14 * 60 * 1000 + 59 * 1000); expect(eyeOf('asha@x.com')).not.toBeNull();
    await tick(1000);
    expect(eyeOf('asha@x.com')).toBeNull();
    expect(passwordCellOf('asha@x.com').textContent).toMatch(/^Hidden/);
    const info = passwordCellOf('asha@x.com').querySelector('.pw-info'); expect(info.getAttribute('title')).toMatch(NOT_RETRIEVABLE); expect(info.getAttribute('aria-label')).toMatch(NOT_RETRIEVABLE);
    expect(document.body.textContent).not.toContain(PW_A); expect(document.body.innerHTML).not.toContain(PW_A);
  });
  it('MEMORY CLEANUP also removes a password that is currently revealed; the 60 s auto-hide does not extend the 15 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await createFirst(); await tick(14 * 60 * 1000); fireEvent.click(eyeOf('asha@x.com')); expect(passwordCellOf('asha@x.com').textContent).toBe(PW_A);
    await tick(60 * 1000);
    expect(eyeOf('asha@x.com')).toBeNull(); expect(document.body.textContent).not.toContain(PW_A);
  });
  it('MEMORY CLEANUP timers are per user: B (saved later) outlives A', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await createFirst(); await tick(5 * 60 * 1000); await createSecond();
    await tick(10 * 60 * 1000 + 1000);
    expect(eyeOf('asha@x.com')).toBeNull(); expect(eyeOf('ravi@x.com')).not.toBeNull();
    await tick(5 * 60 * 1000); expect(eyeOf('ravi@x.com')).toBeNull();
  });

  it('when the USER changes their own password (server now says must_change_password=false) the remembered password is cleared: "Set by user", and it never comes back', async () => {
    await createFirst();
    listUsers.mockResolvedValue([ROWS[0], { ...U1, must_change_password: false }]);
    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(passwordCellOf('asha@x.com').textContent).toBe('Set by user'));
    expect(eyeOf('asha@x.com')).toBeNull(); expect(document.body.textContent).not.toContain(PW_A);
    listUsers.mockResolvedValue([ROWS[0], U1]);                                  // e.g. an admin reset flagged them again elsewhere
    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(passwordCellOf('asha@x.com').textContent).toMatch(/^Hidden/));
    expect(eyeOf('asha@x.com')).toBeNull();                                      // the OLD password was really forgotten, not just hidden
  });
  it('a STALE user list (requested before the password was saved) can never purge a newer password', async () => {
    await startPasswordPage();
    listUsers.mockResolvedValue([ROWS[0], U1]); fireEvent.click(screen.getByTitle('Refresh')); await screen.findByText('asha@x.com');
    let releaseStale; const stale = new Promise(r => { releaseStale = r; });
    listUsers.mockReturnValueOnce(stale); fireEvent.click(screen.getByTitle('Refresh'));            // a refresh that is still in flight...
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    adminUsers.mockResolvedValue({}); listUsers.mockResolvedValue([ROWS[0], U1]);
    fireEvent.click(within(rowOf('asha@x.com')).getByRole('button', { name: 'Reset password' }));   // ...while the admin resets Asha's password
    await screen.findByText('Password reset'); fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await act(async () => { releaseStale([ROWS[0], { ...U1, must_change_password: false }]); });   // the OLD answer arrives late
    listUsers.mockResolvedValue([ROWS[0], U1]); fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(eyeOf('asha@x.com')).not.toBeNull());                                // still remembered
    spy.mockRestore();
  });

  it('RESET PASSWORD remembers the generated password: the eye shows exactly what the one-time dialog showed', async () => {
    await startPasswordPage(); listUsers.mockResolvedValue([ROWS[0], U1]); fireEvent.click(screen.getByTitle('Refresh')); await screen.findByText('asha@x.com');
    expect(eyeOf('asha@x.com')).toBeNull();                                      // before: pending but unknown to this session
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('asha@x.com')).getByRole('button', { name: 'Reset password' }));
    await screen.findByText('Password reset');
    const shownOnce = document.querySelectorAll('.modal-backdrop input')[1].value; expect(shownOnce).toHaveLength(14);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.body.textContent).not.toContain(shownOnce);
    fireEvent.click(eyeOf('asha@x.com')); expect(passwordCellOf('asha@x.com').textContent).toBe(shownOnce);
    spy.mockRestore();
  });
  it('EDIT PASSWORD remembers the password the admin typed', async () => {
    await startPasswordPage(); listUsers.mockResolvedValue([ROWS[0], U1]); fireEvent.click(screen.getByTitle('Refresh')); await screen.findByText('asha@x.com');
    fireEvent.click(within(rowOf('asha@x.com')).getByRole('button', { name: 'Edit password' }));
    fillPw('Typed-By-Admin-77', 'Typed-By-Admin-77'); submitPw();
    await waitFor(() => expect(document.querySelector('.edit-modal')).toBeNull());
    expect(document.body.textContent).not.toContain('Typed-By-Admin-77');
    fireEvent.click(eyeOf('asha@x.com')); expect(passwordCellOf('asha@x.com').textContent).toBe('Typed-By-Admin-77');
  });
  it('a FAILED create or edit remembers nothing', async () => {
    await startPasswordPage();
    adminUsers.mockRejectedValueOnce(new Error('Creating the login failed: nope'));
    fireEvent.change(document.querySelector('.add-form select'), { target: { value: '1' } });
    fireEvent.change(document.querySelector('.add-form input[type=email]'), { target: { value: 'asha@x.com' } });
    fireEvent.change(createPwInput(), { target: { value: PW_A } });
    fireEvent.submit(document.querySelector('.add-form'));
    await waitFor(() => expect(toastText()).toMatch(/nope/));
    listUsers.mockResolvedValue([ROWS[0], U1]); fireEvent.click(screen.getByTitle('Refresh')); await screen.findByText('asha@x.com');
    expect(eyeOf('asha@x.com')).toBeNull();
    adminUsers.mockRejectedValueOnce(new Error('Resetting the password failed: weak'));
    fireEvent.click(within(rowOf('asha@x.com')).getByRole('button', { name: 'Edit password' })); fillPw(GOOD, GOOD); submitPw();
    await waitFor(() => expect(document.querySelector('.edit-modal .error-box')).not.toBeNull());
    fireEvent.click(within(document.querySelector('.edit-modal')).getByRole('button', { name: 'Cancel' }));
    expect(eyeOf('asha@x.com')).toBeNull();
  });
  it('a pending user this session knows nothing about shows "Hidden" + the explanation and NO eye; admins show a dash; finished users show "Set by user"', async () => {
    await startPasswordPage(); listUsers.mockResolvedValue([ROWS[0], U1, { ...U2, must_change_password: false }]); fireEvent.click(screen.getByTitle('Refresh')); await screen.findByText('ravi@x.com');
    expect(passwordCellOf('asha@x.com').textContent).toMatch(/^Hidden/); expect(eyeOf('asha@x.com')).toBeNull();
    expect(passwordCellOf('asha@x.com').querySelector('.pw-info').getAttribute('title')).toBe('Passwords are stored only as a hash by Supabase Auth and cannot be retrieved. Use Reset password to set a new one.');
    expect(passwordCellOf('ravi@x.com').textContent).toBe('Set by user'); expect(eyeOf('ravi@x.com')).toBeNull();
    expect(passwordCellOf('amohan@x.com').textContent).toBe('—'); expect(within(rowOf('amohan@x.com')).queryAllByRole('button')).toHaveLength(0);
  });
  it('the existing row actions are unchanged next to the new column', async () => {
    await createFirst();
    expect(within(rowOf('asha@x.com')).getAllByRole('button').map(b => b.textContent.trim()).filter(Boolean)).toEqual(['Edit email', 'Edit password', 'Deactivate', 'Reset password']);
  });

  it('NOTHING is persisted: not one write to localStorage or sessionStorage, and no password in any storage, cookie or URL, before or after revealing', async () => {
    const makeStore = () => { const m = new Map(); return { setItem: vi.fn((k, v) => { m.set(k, String(v)); }), getItem: k => (m.has(k) ? m.get(k) : null), removeItem: k => { m.delete(k); }, clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, dump: () => JSON.stringify([...m]) }; };
    const ls = makeStore(), ss = makeStore(); vi.stubGlobal('localStorage', ls); vi.stubGlobal('sessionStorage', ss);
    try {
      await createFirst(); fireEvent.click(eyeOf('asha@x.com')); await createSecond(); fireEvent.click(eyeOf('ravi@x.com'));
      expect(ls.setItem).not.toHaveBeenCalled(); expect(ss.setItem).not.toHaveBeenCalled();        // not one write by this whole flow
      expect(ls.dump() + ss.dump() + document.cookie).not.toMatch(/Alpha-Secret|Bravo-Secret/);
      expect(window.location.href).not.toMatch(/Alpha-Secret|Bravo-Secret/);
    } finally { vi.unstubAllGlobals(); }
  });
  it('leaving User Management drops every remembered password (and its timers) with no React warnings', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await createFirst(); fireEvent.click(eyeOf('asha@x.com'));
    fireEvent.click(within(document.querySelector('nav')).getByText('Dashboard')); await screen.findByText('Overview');
    expect(document.body.textContent).not.toContain(PW_A);
    await tick(20 * 60 * 1000);                                                  // timers must not fire into an unmounted page
    fireEvent.click(within(document.querySelector('nav')).getByText('User Management')); await screen.findByText('User accounts');
    await waitFor(() => expect(screen.getByText('asha@x.com')).not.toBeNull());
    expect(eyeOf('asha@x.com')).toBeNull(); expect(passwordCellOf('asha@x.com').textContent).toMatch(/^Hidden/);
    expect(err).not.toHaveBeenCalled(); err.mockRestore();
  });
});
