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
  it('sees only Dashboard / Take Snacks / Snack History / Month Records, with their name and role USER', async () => {
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBeGreaterThan(0));
    expect(navNames()).toEqual(['Dashboard', 'Take Snacks', 'Snack History', 'Month Records']);
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
    await waitFor(() => expect(navNames().length).toBe(4));
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
    await waitFor(() => expect(navNames().length).toBe(4));
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
    await waitFor(() => expect(navNames()).toEqual(['Dashboard', 'Take Snacks', 'Snack History', 'Month Records']));
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
    await waitFor(() => expect(navNames().length).toBe(4));
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

// ---- USER own-record views: date filter, Month Records, own-employee display, "No Snacks" ----
const kolkataDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const todayStr = kolkataDay(new Date());
const shift = (iso, days) => { const [y, m, d] = iso.split('-').map(Number); return kolkataDay(new Date(Date.UTC(y, m - 1, d + days, 6))); };
const yesterdayStr = shift(todayStr, -1);
const rec = (id, day, snackName, quantity, unitPrice, breakType = 'MORNING') => ({ id, employeeId: 1, employeeName: 'Asha', snackId: id, snackName, quantity, breakType, unitPrice, amount: unitPrice == null ? null : unitPrice * quantity, takenAt: `${day}T10:00:00+05:30` });
const dataset = [rec(1, todayStr, 'TodayTea', 1, 10), rec(2, yesterdayStr, 'YesterdayVada', 2, 15), rec(3, '2026-10-05', 'OctSamosa', 3, 20), rec(4, '2026-10-20', 'OctPuff', 1, 25, 'EVENING')];
const inRange = (r, q) => {
  const day = kolkataDay(new Date(r.takenAt));
  if (q.has('date')) return day === q.get('date');
  return (!q.has('from') || day >= q.get('from')) && (!q.has('to') || day <= q.get('to'));
};
function datedApi() {
  api.mockImplementation(async (path, opts) => {
    if (path.startsWith('/records') && !opts?.method) return dataset.filter(r => inRange(r, new URL(path, 'http://x').searchParams));
    return defaultApi(path, opts);
  });
}
const recordCalls = () => api.mock.calls.map(c => c[0]).filter(p => p.startsWith('/records'));
const goTo = (name) => fireEvent.click(within(document.querySelector('nav')).getByText(name));

describe('USER: Recent snack records date filter', () => {
  it('Today shows only today; Yesterday shows only yesterday and never mixes the two', async () => {
    datedApi();
    await signInAs(user);
    await screen.findByText(/TodayTea/);
    expect(screen.queryByText(/YesterdayVada/)).toBeNull();
    expect(screen.queryByLabelText('Custom date')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
    await screen.findByText(/YesterdayVada/);
    expect(screen.queryByText(/TodayTea/)).toBeNull();
    expect(recordCalls()).toContain(`/records?date=${yesterdayStr}`);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await screen.findByText(/TodayTea/);
    expect(screen.queryByText(/YesterdayVada/)).toBeNull();
  });
  it('Custom date queries exactly the chosen day and shows a clear empty state', async () => {
    datedApi();
    await signInAs(user);
    await screen.findByText(/TodayTea/);
    fireEvent.click(screen.getByRole('button', { name: 'Custom date' }));
    fireEvent.change(screen.getByLabelText('Custom date'), { target: { value: '2026-10-05' } });
    await screen.findByText(/OctSamosa/);
    expect(screen.queryByText(/TodayTea/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Custom date'), { target: { value: '2026-01-02' } });
    await screen.findByText('You have not recorded any snacks on 2026-01-02.'); expect(screen.queryByText('No Snacks')).toBeNull();
    expect(recordCalls()).toContain('/records?date=2026-01-02');
  });
  it('shows the Today/Yesterday empty states in words', async () => {
    api.mockImplementation(async (path, opts) => (path.startsWith('/records') ? [] : defaultApi(path, opts)));
    await signInAs(user);
    await screen.findByText('You have not recorded any snacks today.'); expect(screen.queryByText('No Snacks')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
    await screen.findByText('You have not recorded any snacks yesterday.');
  });
  it('ADMIN keeps the original single "View date" input and no quick buttons', async () => {
    await signInAs(admin);
    await screen.findByText('Total employees');
    expect(screen.getByText('View date')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Yesterday' })).toBeNull();
  });
});

describe('USER: Month Records', () => {
  it('lists only the selected month with the user columns and monthly totals; switching months refreshes', async () => {
    datedApi();
    await signInAs(user);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await screen.findByText(/TodayTea/);
    const headers = [...document.querySelectorAll('thead th')].map(h => h.textContent);
    expect(headers).toEqual(['DATE', 'TIME', 'SNACK', 'BREAK', 'QTY', 'UNIT PRICE', 'AMOUNT']);
    expect([...document.querySelectorAll('.stat-card .stat-top span:first-child')].map(e => e.textContent)).not.toContain('Employees');
    expect(document.querySelector('.own-employee b').textContent).toBe('Asha');
    expect(screen.queryByText(/OctSamosa/)).toBeNull();
    const month = document.querySelector('input[type=month]');
    expect(month.max).toBe(todayStr.slice(0, 7));
    fireEvent.change(month, { target: { value: '2026-10' } });
    await screen.findByText(/OctSamosa/);
    expect(screen.getByText(/OctPuff/)).toBeTruthy();
    expect(screen.queryByText(/TodayTea/)).toBeNull();
    expect(recordCalls()).toContain('/records?from=2026-10-01&to=2026-10-31');
    const stats = [...document.querySelectorAll('.stat-card')].map(c => c.textContent);
    expect(stats.some(t => t.includes('Total quantity') && t.includes('4'))).toBe(true);
    expect(stats.some(t => /Known amount/.test(t) && t.includes('85.00'))).toBe(true);
  });
  it('an empty month shows a proper empty state', async () => {
    datedApi();
    await signInAs(user);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await screen.findByText(/TodayTea/);
    fireEvent.change(document.querySelector('input[type=month]'), { target: { value: '2025-03' } });
    await screen.findByText('No records found for March 2025.'); expect(screen.getByText('Nothing recorded')).toBeTruthy(); expect(screen.queryByText('No Snacks')).toBeNull();
    expect(screen.queryByText(/TodayTea/)).toBeNull();
  });
  it('a load failure shows the error instead of silently failing', async () => {
    api.mockImplementation(async (path, opts) => { if (path.startsWith('/records')) throw new Error('boom'); return defaultApi(path, opts); });
    await signInAs(user);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await waitFor(() => expect(screen.getAllByText(/boom/).length).toBeGreaterThan(0));
  });
  it('ADMIN Month Records keeps Record/Employee columns and the Employees stat', async () => {
    datedApi();
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await screen.findByText(/TodayTea/);
    expect([...document.querySelectorAll('thead th')].map(h => h.textContent)).toEqual(['RECORD', 'DATE', 'TIME', 'EMPLOYEE', 'SNACK', 'BREAK', 'QTY', 'UNIT PRICE', 'AMOUNT']);
    expect([...document.querySelectorAll('.stat-card .stat-top span:first-child')].map(e => e.textContent)).toContain('Employees');
  });
});

describe('Employee selection and No Snacks', () => {
  const snacksApi = (snacks) => api.mockImplementation(async (path, opts) => (path === '/snacks' ? snacks : defaultApi(path, opts)));
  it('USER: Take Snacks shows only their own name - no employee dropdown, no "All employees"', async () => {
    snacksApi([{ id: 1, name: 'Tea', active: true, unitPrice: 10 }]);
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Take Snacks');
    await screen.findByText('Snack details');
    await waitFor(() => expect(document.querySelector('.own-employee b').textContent).toBe('Asha'));
    expect(screen.queryByText('Choose an employee')).toBeNull();
    expect(screen.queryByText(/all employees/i)).toBeNull();
    expect(screen.getByRole('option', { name: 'Tea' })).toBeTruthy();
  });
  it('USER: Snack History has no employee filter / "All employees" option', async () => {
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Snack History');
    await screen.findByText('Snack records');
    expect(screen.queryByText('All employees')).toBeNull();
    expect(document.querySelector('.own-employee b').textContent).toBe('Asha');
  });
  it('ADMIN: still has the employee dropdown and "All employees" filter', async () => {
    api.mockImplementation(async (path, opts) => (path === '/employees' ? [{ id: 1, name: 'Asha', active: true }, { id: 2, name: 'Ravi', active: true }] : defaultApi(path, opts)));
    await signInAs(admin);
    await waitFor(() => expect(navNames().length).toBe(8));
    goTo('Take Snacks');
    await screen.findByText('Choose an employee');
    expect(screen.getByRole('option', { name: 'Ravi' })).toBeTruthy();
    goTo('Snack History');
    await screen.findByText('All employees');
  });
  it('no active snacks: the dropdown still offers Choose a snack + the explicit No Snacks option; a normal save is blocked and nothing is posted', async () => {
    snacksApi([{ id: 1, name: 'Old', active: false }]);
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Take Snacks');
    await screen.findByRole('option', { name: 'Choose a snack' });
    expect(screen.getByRole('option', { name: 'No Snacks' }).value).toBe('NO_SNACKS');
    expect(document.body.textContent).not.toMatch(/undefined|null/);
    const form = document.querySelector('.entry-form');
    fireEvent.change(form.querySelector('select'), { target: { value: 'MORNING' } });
    fireEvent.submit(form);
    await screen.findByText('Choose a snack and enter a whole-number quantity above zero for every row.');
    expect(api.mock.calls.filter(c => c[1]?.method === 'POST').length).toBe(0);
  });
  it('active snacks appear normally, next to the explicit No Snacks option', async () => {
    snacksApi([{ id: 1, name: 'Tea', active: true, unitPrice: 10 }, { id: 2, name: 'Biscuit', active: true, unitPrice: 5 }]);
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Take Snacks');
    await screen.findByRole('option', { name: 'Choose a snack' });
    expect(screen.getByRole('option', { name: 'No Snacks' }).value).toBe('NO_SNACKS');
    expect(screen.getByRole('option', { name: 'Biscuit' })).toBeTruthy();
  });
  it('ADMIN also gets the No Snacks option (alongside the employee dropdown)', async () => {
    api.mockImplementation(async (path, opts) => (path === '/snacks' ? [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }] : path === '/employees' ? [{ id: 1, name: 'Asha', active: true }] : defaultApi(path, opts)));
    await signInAs(admin);
    await waitFor(() => expect(navNames().length).toBe(8));
    goTo('Take Snacks');
    await screen.findByRole('option', { name: 'Tea' });
    expect(screen.getByRole('option', { name: 'No Snacks' }).value).toBe('NO_SNACKS');
    expect(screen.getByLabelText('Employee')).toBeTruthy();
  });
});

// ---- Explicit "No Snacks" submission (USER only) ----
describe('No Snacks submission', () => {
  const nsRow = { id: 'ns-1', noSnacks: true, employeeId: 1, employeeName: 'Asha', snackName: 'No Snacks', quantity: null, breakType: 'MORNING', unitPrice: null, amount: null, takenAt: `${todayStr}T09:30:00+05:30` };
  const nsEvening = { ...nsRow, id: 'ns-2', breakType: 'EVENING', takenAt: `${todayStr}T16:30:00+05:30` };
  const setBreak = (form, v) => fireEvent.change(form.querySelector('select'), { target: { value: v } });
  const setup = ({ records = [], noToday = [], post } = {}) => api.mockImplementation(async (path, opts) => {
    if (path === '/snacks') return [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }];
    if (path.startsWith('/no-snacks') && opts?.method === 'POST') return post ? post(opts) : nsRow;
    if (path.startsWith('/no-snacks')) return noToday;
    if (path.startsWith('/records') && !opts?.method) return records;
    return defaultApi(path, opts);
  });
  const openTake = async () => { await signInAs(user); await waitFor(() => expect(navNames().length).toBe(4)); goTo('Take Snacks'); await screen.findByRole('option', { name: 'No Snacks' }); return document.querySelector('.entry-form'); };
  const pick = (form, value) => fireEvent.change(form.querySelector('.snack-item-row select'), { target: { value } });
  const posts = (prefix) => api.mock.calls.filter(c => c[1]?.method === 'POST' && String(c[0]).startsWith(prefix));

  it('Morning + No Snacks saves a Morning No Snacks only (own employee, no snack record, quantity/add-another locked)', async () => {
    setup();
    const form = await openTake();
    setBreak(form, 'MORNING');
    pick(form, 'NO_SNACKS');
    expect(form.querySelector('.snack-item-row input[type=number]').disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Add another snack/ }).disabled).toBe(true);
    fireEvent.submit(form);
    await screen.findByText('No Snacks recorded for the Morning break.');
    expect(posts('/no-snacks').length).toBe(1);
    expect(JSON.parse(posts('/no-snacks')[0][1].body)).toEqual({ employeeId: 1, breakType: 'MORNING' });
    expect(posts('/records').length).toBe(0);
  });
  it('Evening + No Snacks saves an Evening No Snacks only', async () => {
    setup();
    const form = await openTake();
    setBreak(form, 'EVENING');
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await screen.findByText('No Snacks recorded for the Evening break.');
    expect(JSON.parse(posts('/no-snacks')[0][1].body)).toEqual({ employeeId: 1, breakType: 'EVENING' });
    expect(posts('/records').length).toBe(0);
  });
  it('No Snacks without choosing a break is refused (nothing posted)', async () => {
    setup();
    const form = await openTake();
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await screen.findByText('Choose Morning or Evening Break.');
    expect(posts('/no-snacks').length).toBe(0);
  });
  it('Morning and Evening No Snacks are independent on the same day; repeating the SAME break is blocked', async () => {
    setup({ noToday: [nsRow] });
    const form = await openTake();
    setBreak(form, 'EVENING');
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await screen.findByText('No Snacks recorded for the Evening break.');
    expect(posts('/no-snacks').length).toBe(1);
    setBreak(form, 'MORNING');
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await screen.findByText('You have already submitted No Snacks for the Morning break today.');
    expect(posts('/no-snacks').length).toBe(1);
  });
  it('a repeated Evening No Snacks is blocked too (nothing posted)', async () => {
    setup({ noToday: [nsEvening] });
    const form = await openTake();
    setBreak(form, 'EVENING');
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await screen.findByText('You have already submitted No Snacks for the Evening break today.');
    expect(posts('/no-snacks').length).toBe(0);
  });
  it('No Snacks is blocked only for a break that already has snacks; the other break is still allowed', async () => {
    setup({ records: [{ id: 5, employeeId: 1, employeeName: 'Asha', snackId: 1, snackName: 'Tea', quantity: 1, breakType: 'MORNING', unitPrice: 10, amount: 10, takenAt: `${todayStr}T10:00:00+05:30` }] });
    const form = await openTake();
    setBreak(form, 'MORNING');
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await screen.findByText('You have already recorded snacks for the Morning break today, so No Snacks cannot be submitted for it.');
    expect(posts('/no-snacks').length).toBe(0);
    setBreak(form, 'EVENING');
    fireEvent.submit(form);
    await screen.findByText('No Snacks recorded for the Evening break.');
    expect(posts('/no-snacks').length).toBe(1);
  });
  it('after a Morning No Snacks, Morning snacks are blocked but Evening snacks save normally', async () => {
    setup({ noToday: [nsRow] });
    const form = await openTake();
    pick(form, '1');
    setBreak(form, 'MORNING');
    fireEvent.submit(form);
    await screen.findByText('You have already submitted No Snacks for the Morning break today, so snacks cannot be added to it.');
    expect(posts('/records').length).toBe(0);
    setBreak(form, 'EVENING');
    fireEvent.submit(form);
    await screen.findByText('1 snack record saved.');
    expect(posts('/records/batch').length).toBe(1);
    expect(JSON.parse(posts('/records/batch')[0][1].body).breakType).toBe('EVENING');
    expect(posts('/no-snacks').length).toBe(0);
  });
  it('shows today\'s No Snacks entry in the side panel', async () => {
    setup({ noToday: [nsRow] });
    await openTake();
    await waitFor(() => expect(document.querySelector('.recent-list')?.textContent).toContain('No Snacks'));
  });
  it('a server error is shown as-is and no success message appears (no fake save)', async () => {
    setup({ post: () => { throw new Error('No Snacks is not installed in this Supabase project.'); } });
    const form = await openTake();
    setBreak(form, 'MORNING');
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await screen.findByText('No Snacks is not installed in this Supabase project.');
    expect(screen.queryByText(/No Snacks recorded for/)).toBeNull();
  });
  it('a normal snack still saves exactly as before (batch POST, no No Snacks call)', async () => {
    setup();
    const form = await openTake();
    pick(form, '1');
    fireEvent.change(form.querySelector('select'), { target: { value: 'MORNING' } });
    fireEvent.submit(form);
    await screen.findByText('1 snack record saved.');
    expect(posts('/records/batch').length).toBe(1);
    expect(posts('/no-snacks').length).toBe(0);
  });
  it('Snack History shows each No Snacks row with employee, date and BREAK, no snack/quantity/price, Edit for today; the break filter applies', async () => {
    setup({ noToday: [nsRow, nsEvening] });
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Snack History');
    const body = () => [...document.querySelectorAll('.table-wrap tbody')].pop();
    await waitFor(() => expect(body()?.querySelectorAll('tr').length).toBe(2));
    const rows = [...body().querySelectorAll('tr')].map(tr => [...tr.children].map(c => c.textContent));
    const evening = rows.find(c => c[3] === 'EVENING'), morning = rows.find(c => c[3] === 'MORNING');
    expect(evening[1]).toBe('Asha'); expect(evening[2]).toBe('No Snacks'); expect([evening[4], evening[5], evening[6]]).toEqual(['—', '—', '—']); expect(evening[7]).toContain('2026');
    expect(morning[2]).toBe('No Snacks');
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBe(2); // today's No Snacks rows are editable
    fireEvent.change(screen.getByLabelText('Break'), { target: { value: 'MORNING' } });
    await waitFor(() => expect(body().querySelectorAll('tr').length).toBe(1));
    expect(body().textContent).toContain('MORNING');
    expect(body().textContent).not.toContain('EVENING');
  });
  it('Month Records lists the No Snacks day with its date and leaves the totals alone', async () => {
    setup({ noToday: [nsRow] });
    api.mockImplementation(async (path, opts) => (path.startsWith('/no-snacks') && !opts?.method ? [nsRow] : path.startsWith('/records') && !opts?.method ? [] : defaultApi(path, opts)));
    await signInAs(user);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await waitFor(() => expect(document.querySelector('tbody')?.textContent).toContain('No Snacks'));
    expect(api.mock.calls.map(c => c[0])).toContain(`/no-snacks?from=${todayStr.slice(0, 7)}-01&to=${todayStr.slice(0, 7)}-${String(new Date(Date.UTC(+todayStr.slice(0, 4), +todayStr.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`);
    expect(document.querySelector('tbody').textContent).toContain('MORNING');
    expect(screen.queryByText('Nothing recorded')).toBeNull();
    const stats = [...document.querySelectorAll('.stat-card')].map(c => c.textContent);
    expect(stats.some(t => t.includes('Snack records') && t.includes('0'))).toBe(true);
  });
  it('the dashboard lists today\'s No Snacks entry', async () => {
    setup({ noToday: [nsRow] });
    await signInAs(user);
    await waitFor(() => expect(document.querySelector('.recent-list')?.textContent).toContain('No Snacks'));
    expect(screen.queryByText('Nothing recorded')).toBeNull();
  });
  const MISSING = 'No Snacks is not installed in this Supabase project. Run database/migrations/2026-11-25-no-snacks-days.sql in the SQL Editor, then reload.';
  const failingNoSnacks = (records = []) => api.mockImplementation(async (path, opts) => {
    if (path.startsWith('/no-snacks')) throw new Error(MISSING);
    if (path === '/snacks') return [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }];
    if (path.startsWith('/records') && !opts?.method) return records;
    return defaultApi(path, opts);
  });
  const teaToday = { id: 9, employeeId: 1, employeeName: 'Asha', snackId: 1, snackName: 'Tea', quantity: 1, breakType: 'MORNING', unitPrice: 10, amount: 10, takenAt: `${todayStr}T10:00:00+05:30` };
  it('missing No Snacks table: dashboard shows the error (not swallowed) and still lists normal records', async () => {
    failingNoSnacks([teaToday]);
    await signInAs(user);
    await screen.findByText(MISSING);
    expect(screen.getByText(/Asha · Tea/)).toBeTruthy();
  });
  it('missing No Snacks table: Snack History and Month Records show the error and still list normal records', async () => {
    failingNoSnacks([teaToday]);
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Snack History');
    await screen.findByText(MISSING);
    expect(document.body.textContent).toContain('Tea');
    goTo('Month Records');
    await screen.findByText(MISSING);
    expect(document.body.textContent).toContain('Tea');
  });
  it('missing No Snacks table: Take Snacks tells the user, and submitting No Snacks shows the error with no success message', async () => {
    api.mockImplementation(async (path, opts) => {
      if (path.startsWith('/no-snacks')) throw new Error(MISSING);
      if (path === '/snacks') return [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }];
      return defaultApi(path, opts);
    });
    const form = await openTake();
    await screen.findByText(MISSING);
    setBreak(form, 'MORNING');
    pick(form, 'NO_SNACKS');
    fireEvent.submit(form);
    await waitFor(() => expect(posts('/no-snacks').length).toBe(1));
    expect(screen.queryByText(/No Snacks recorded for/)).toBeNull();
  });
  it('ADMIN Dashboard and Snack History never request No Snacks rows (only Reports and Month Records do)', async () => {
    setup({ noToday: [nsRow] });
    await signInAs(admin);
    await screen.findByText('Total employees');
    goTo('Snack History'); await screen.findByText('Snack records');
    expect(api.mock.calls.some(c => String(c[0]).startsWith('/no-snacks'))).toBe(false);
  });
});

// ---- Editing a No Snacks record (USER, Snack History) ----
describe('Edit No Snacks', () => {
  const nsBase = { noSnacks: true, employeeId: 1, employeeName: 'Asha', snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null, day: todayStr };
  const nsM = { ...nsBase, id: 'ns-1', breakType: 'MORNING', takenAt: `${todayStr}T09:30:00+05:30` };
  const nsE = { ...nsBase, id: 'ns-2', breakType: 'EVENING', takenAt: `${todayStr}T16:30:00+05:30` };
  const nsOld = { ...nsBase, id: 'ns-9', breakType: 'MORNING', day: yesterdayStr, takenAt: `${yesterdayStr}T09:00:00+05:30` };
  // A tiny stateful stand-in for the database so refreshes show real before/after state.
  const server = ({ failPut } = {}) => {
    const st = { ns: [nsM, nsE, nsOld], recs: [], puts: [] };
    api.mockImplementation(async (path, opts) => {
      if (path === '/snacks') return [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }];
      if (path.startsWith('/no-snacks/') && opts?.method === 'PUT') {
        const body = JSON.parse(opts.body);
        st.puts.push([path, body]);
        if (failPut) throw new Error(failPut);
        const row = st.ns.find(n => `/no-snacks/${n.id}` === path);
        st.ns = st.ns.filter(n => n !== row);
        const made = { ...rec(77, todayStr, 'Tea', body.quantity, 10, row.breakType), employeeName: 'Asha' };
        st.recs.push(made);
        return made;
      }
      if (path.startsWith('/no-snacks')) { const q = new URL(path, 'http://x').searchParams; return st.ns.filter(n => (q.has('date') ? n.day === q.get('date') : (!q.has('from') || n.day >= q.get('from')) && (!q.has('to') || n.day <= q.get('to')))); }
      if (path.startsWith('/records') && !opts?.method) return st.recs.filter(r => inRange(r, new URL(path, 'http://x').searchParams));
      return defaultApi(path, opts);
    });
    return st;
  };
  const body = () => [...document.querySelectorAll('.table-wrap tbody')].pop();
  const rowOf = (text) => [...body().querySelectorAll('tr')].find(tr => tr.textContent.includes(text));
  const openHistory = async () => { await signInAs(user); await waitFor(() => expect(navNames().length).toBe(4)); goTo('Snack History'); await waitFor(() => expect(body()?.querySelectorAll('tr').length).toBe(2)); };
  const convert = async (breakText, qty) => {
    fireEvent.click(within(rowOf(breakText)).getByRole('button', { name: 'Edit' }));
    const modal = document.querySelector('.edit-modal');
    fireEvent.change(modal.querySelector('select'), { target: { value: '1' } });
    fireEvent.change(modal.querySelector('input[type=number]'), { target: { value: String(qty) } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
  };

  it('Morning No Snacks -> normal snack: modal shows employee/break, saves via the atomic call, history refreshes, Evening No Snacks is untouched', async () => {
    const st = server();
    await openHistory();
    fireEvent.click(within(rowOf('MORNING')).getByRole('button', { name: 'Edit' }));
    const modal = document.querySelector('.edit-modal');
    expect(modal.textContent).toContain('Edit No Snacks'); expect(modal.textContent).toContain('Asha'); expect(modal.textContent).toContain('MORNING break');
    fireEvent.change(modal.querySelector('select'), { target: { value: '1' } });
    fireEvent.change(modal.querySelector('input[type=number]'), { target: { value: '2' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await screen.findByText('No Snacks changed to a snack record for the Morning break.');
    expect(st.puts).toEqual([['/no-snacks/ns-1', { snackId: 1, quantity: 2 }]]);
    await waitFor(() => expect(document.querySelector('.edit-modal')).toBeNull());
    await waitFor(() => expect(rowOf('Tea')).toBeTruthy());
    expect(rowOf('Tea').textContent).toContain('MORNING');           // break unchanged
    expect(rowOf('EVENING').textContent).toContain('No Snacks');      // the other break is untouched
    expect(api.mock.calls.filter(c => c[1]?.method === 'POST').length).toBe(0);
  });
  it('Evening No Snacks -> normal snack independently; the Morning No Snacks is untouched', async () => {
    const st = server();
    await openHistory();
    await convert('EVENING', 3);
    await screen.findByText('No Snacks changed to a snack record for the Evening break.');
    expect(st.puts).toEqual([['/no-snacks/ns-2', { snackId: 1, quantity: 3 }]]);
    await waitFor(() => expect(rowOf('Tea')).toBeTruthy());
    expect(rowOf('Tea').textContent).toContain('EVENING');
    expect(rowOf('MORNING').textContent).toContain('No Snacks');
  });
  it('both breaks can be edited one after the other, each independent of the other', async () => {
    const st = server();
    await openHistory();
    await convert('MORNING', 1);
    await screen.findByText('No Snacks changed to a snack record for the Morning break.');
    await waitFor(() => expect(rowOf('Tea')).toBeTruthy());
    await convert('EVENING', 4);
    await waitFor(() => expect(st.puts.length).toBe(2));
    await waitFor(() => expect([...body().querySelectorAll('tr')].every(tr => tr.textContent.includes('Tea'))).toBe(true));
    expect(st.ns.map(n => n.id)).toEqual(['ns-9']);
  });
  it('a failed update (e.g. a snack already exists for that break) shows the real error, no success message, and the row stays No Snacks', async () => {
    const st = server({ failPut: 'Snacks are already recorded for this break today, so this No Snacks cannot be converted.' });
    await openHistory();
    await convert('MORNING', 2);
    await screen.findByText('Snacks are already recorded for this break today, so this No Snacks cannot be converted.');
    expect(screen.queryByText(/No Snacks changed to a snack record/)).toBeNull();
    expect(document.querySelector('.edit-modal')).not.toBeNull();     // stays open so nothing looks saved
    expect(st.ns.length).toBe(3);
    expect(rowOf('MORNING').textContent).toContain('No Snacks');
  });
  it('choosing no snack is refused locally (nothing sent)', async () => {
    const st = server();
    await openHistory();
    fireEvent.click(within(rowOf('MORNING')).getByRole('button', { name: 'Edit' }));
    fireEvent.submit(document.querySelector('.edit-modal')); // (the browser's own `required` check would also block a blank snack)
    await screen.findByText('Choose a snack and enter a whole-number quantity above zero.');
    expect(st.puts.length).toBe(0);
  });
  it("only today's No Snacks has an Edit button (no back-dating)", async () => {
    server();
    await openHistory();
    expect(within(rowOf('MORNING')).queryByRole('button', { name: 'Edit' })).not.toBeNull();
    fireEvent.change(document.querySelector('input[type=date]'), { target: { value: yesterdayStr } });
    await waitFor(() => expect(body().textContent).toContain('No Snacks'));
    expect(within(body()).queryByRole('button', { name: 'Edit' })).toBeNull();
  });
  it('Month Records reflects the conversion: the new snack appears and only the other break remains No Snacks', async () => {
    server();
    await openHistory();
    await convert('MORNING', 2);
    await screen.findByText('No Snacks changed to a snack record for the Morning break.');
    goTo('Month Records');
    await waitFor(() => expect(document.querySelector('.table-wrap tbody')?.textContent).toContain('Tea'));
    const text = document.querySelector('.table-wrap tbody').textContent;
    expect((text.match(/No Snacks/g) || []).length).toBe(2); // today's Evening + yesterday's older record; today's Morning is now a snack
    expect(text).toContain('EVENING');
  });
  it('the normal snack edit is unchanged (same modal, PUT /records/:id)', async () => {
    const mine = rec(7, todayStr, 'Tea', 2, 10);
    api.mockImplementation(async (path, opts) => {
      if (path.startsWith('/records') && opts?.method === 'PUT') return { ...mine, ...JSON.parse(opts.body) };
      if (path.startsWith('/records')) return [mine];
      if (path === '/snacks') return [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }];
      return defaultApi(path, opts);
    });
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Snack History');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const modal = document.querySelector('.edit-modal');
    expect(modal.textContent).toContain('Edit snack record');
    fireEvent.change(modal.querySelector('input[type=number]'), { target: { value: '5' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Update' }));
    await screen.findByText('Snack record updated.');
    expect(api.mock.calls.find(c => c[1]?.method === 'PUT')[0]).toBe('/records/7');
  });
});

// ---- Dashboard heading follows the selected day; Edit only for TODAY's records (USER) ----
describe('Date-aware dashboard heading and Edit visibility', () => {
  const heading = () => document.querySelector('.recent-list')?.closest('.panel')?.querySelector('h2')?.textContent
    ?? [...document.querySelectorAll('.panel h2')].map(h => h.textContent).find(t => /Snacks|Recent snack records/.test(t));
  const body = () => [...document.querySelectorAll('.table-wrap tbody')].pop();
  const rowOf = (text) => [...body().querySelectorAll('tr')].find(tr => tr.textContent.includes(text));
  const histDate = (v) => fireEvent.change(document.querySelector('input[type=date]'), { target: { value: v } });

  it("Today shows \"Today's Snacks\"; Yesterday shows \"Yesterday's Snacks\"; a past date shows \"Snacks for <date>\" - heading and records change together", async () => {
    datedApi();
    await signInAs(user);
    await screen.findByText(/TodayTea/);
    expect(screen.getByRole('heading', { name: "Today's Snacks" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
    await screen.findByText(/YesterdayVada/);
    expect(screen.getByRole('heading', { name: "Yesterday's Snacks" })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: "Today's Snacks" })).toBeNull();
    expect(screen.queryByText(/TodayTea/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custom date' }));
    fireEvent.change(screen.getByLabelText('Custom date'), { target: { value: '2026-10-05' } });
    await screen.findByText(/OctSamosa/);
    expect(screen.getByRole('heading', { name: 'Snacks for 5 Oct 2026' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: "Yesterday's Snacks" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await screen.findByText(/TodayTea/);
    expect(screen.getByRole('heading', { name: "Today's Snacks" })).toBeTruthy();
  });
  it('ADMIN dashboard heading is unchanged ("Recent snack records")', async () => {
    datedApi();
    await signInAs(admin);
    await screen.findByText('Total employees');
    expect(screen.getByRole('heading', { name: 'Recent snack records' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: "Today's Snacks" })).toBeNull();
  });
  it("USER Snack History: today's normal snack has Edit; yesterday's and older do not (decided by the record's own date)", async () => {
    datedApi();
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Snack History');
    await waitFor(() => expect(body()?.textContent).toContain('TodayTea'));
    expect(within(rowOf('TodayTea')).queryByRole('button', { name: 'Edit' })).not.toBeNull();
    histDate(yesterdayStr);
    await waitFor(() => expect(body()?.textContent).toContain('YesterdayVada'));
    expect(body().textContent).not.toContain('TodayTea');
    expect(within(body()).queryByRole('button', { name: 'Edit' })).toBeNull();
    histDate('2026-10-05');
    await waitFor(() => expect(body()?.textContent).toContain('OctSamosa'));
    expect(within(body()).queryByRole('button', { name: 'Edit' })).toBeNull();
  });
  it("USER Snack History: today's Morning and Evening No Snacks have Edit; yesterday's No Snacks does not", async () => {
    const base = { noSnacks: true, employeeId: 1, employeeName: 'Asha', snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null };
    const rows = [
      { ...base, id: 'ns-1', breakType: 'MORNING', day: todayStr, takenAt: `${todayStr}T09:30:00+05:30` },
      { ...base, id: 'ns-2', breakType: 'EVENING', day: todayStr, takenAt: `${todayStr}T16:30:00+05:30` },
      { ...base, id: 'ns-3', breakType: 'MORNING', day: yesterdayStr, takenAt: `${yesterdayStr}T09:30:00+05:30` },
    ];
    api.mockImplementation(async (path, opts) => {
      if (path.startsWith('/no-snacks') && !opts?.method) { const q = new URL(path, 'http://x').searchParams; return rows.filter(r => r.day === q.get('date')); }
      if (path.startsWith('/records') && !opts?.method) return [];
      return defaultApi(path, opts);
    });
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTo('Snack History');
    await waitFor(() => expect(body()?.querySelectorAll('tr').length).toBe(2));
    expect(within(rowOf('MORNING')).queryByRole('button', { name: 'Edit' })).not.toBeNull();
    expect(within(rowOf('EVENING')).queryByRole('button', { name: 'Edit' })).not.toBeNull();
    histDate(yesterdayStr);
    await waitFor(() => expect(body()?.textContent).toContain('No Snacks'));
    expect(body().querySelectorAll('tr').length).toBe(1);
    expect(within(body()).queryByRole('button', { name: 'Edit' })).toBeNull();
  });
  it('ADMIN keeps Edit (and Delete) on past records - admin permissions are unchanged', async () => {
    datedApi();
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Snack History'));
    goTo('Snack History');
    await screen.findByText('Snack records');
    histDate(yesterdayStr);
    await waitFor(() => expect(body()?.textContent).toContain('YesterdayVada'));
    expect(within(rowOf('YesterdayVada')).queryByRole('button', { name: 'Edit' })).not.toBeNull();
    expect(within(rowOf('YesterdayVada')).queryByRole('button', { name: 'Delete' })).not.toBeNull();
  });
  it('USER Month Records never offers Edit, for today or past dates', async () => {
    datedApi();
    await signInAs(user);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await screen.findByText(/TodayTea/);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.change(document.querySelector('input[type=month]'), { target: { value: '2026-10' } });
    await screen.findByText(/OctSamosa/);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

// ---- Admin Reports include No Snacks (separately from snack totals) ----
describe('ADMIN Reports: No Snacks', () => {
  const nsBase = { noSnacks: true, snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null };
  const nsRows = [
    { ...nsBase, id: 'ns-1', employeeId: 2, employeeName: 'Ravi', breakType: 'MORNING', day: todayStr, takenAt: `${todayStr}T09:30:00+05:30` },
    { ...nsBase, id: 'ns-2', employeeId: 3, employeeName: 'Meera', breakType: 'EVENING', day: todayStr, takenAt: `${todayStr}T16:30:00+05:30` },
    { ...nsBase, id: 'ns-3', employeeId: 2, employeeName: 'Ravi', breakType: 'EVENING', day: '2026-10-05', takenAt: '2026-10-05T16:30:00+05:30' },
  ];
  const teaToday = { id: 1, employeeId: 1, employeeName: 'Asha', snackId: 1, snackName: 'Tea', quantity: 2, breakType: 'MORNING', unitPrice: 10, amount: 20, takenAt: `${todayStr}T10:00:00+05:30` };
  const reportApi = ({ failNoSnacks } = {}) => api.mockImplementation(async (path, opts) => {
    if (path.startsWith('/no-snacks') && !opts?.method) {
      if (failNoSnacks) throw new Error(failNoSnacks);
      const q = new URL(path, 'http://x').searchParams;
      return nsRows.filter(n => n.day >= q.get('from') && n.day <= q.get('to'));
    }
    if (path.startsWith('/records') && !opts?.method) return [teaToday].filter(r => inRange(r, new URL(path, 'http://x').searchParams));
    return defaultApi(path, opts);
  });
  const noPanel = () => document.querySelector('[data-testid="no-snacks-report"]');
  const stat = (label) => [...document.querySelectorAll('.break-report-stats .stat-card')].find(c => c.textContent.includes(label)).querySelector('strong').textContent;

  it('lists No Snacks next to the normal report with employee, date and break; snack totals ignore them', async () => {
    reportApi();
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Reports'));
    goTo('Reports');
    await waitFor(() => expect(noPanel()).not.toBeNull());
    const cells = [...noPanel().querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.textContent));
    expect(cells.length).toBe(2);
    const ravi = cells.find(c => c[0] === 'Ravi'), meera = cells.find(c => c[0] === 'Meera');
    expect(ravi.slice(2, 4)).toEqual(['MORNING', 'No Snacks']); expect(meera.slice(2, 4)).toEqual(['EVENING', 'No Snacks']);
    expect(ravi[1]).toMatch(/2026/);
    // normal snack report is intact and is NOT inflated by No Snacks
    expect(screen.getByText('Tea')).toBeTruthy();
    expect(stat('Snack records')).toBe('1'); expect(stat('Total quantity')).toBe('2'); expect(stat('Employees')).toBe('1');
    expect(stat('Known expenses')).toMatch(/20\.00/);
    expect(screen.queryByText('No report data for this period.')).toBeNull();
    expect(api.mock.calls.map(c => c[0])).toContain(`/no-snacks?from=${todayStr}&to=${todayStr}`);
  });
  it('the Break filter applies to No Snacks too (Morning shows only Morning; Evening only Evening)', async () => {
    reportApi();
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Reports'));
    goTo('Reports');
    await waitFor(() => expect(noPanel()).not.toBeNull());
    fireEvent.change(screen.getByLabelText('Break'), { target: { value: 'MORNING' } });
    await waitFor(() => expect(noPanel().querySelectorAll('tbody tr').length).toBe(1));
    expect(noPanel().textContent).toContain('Ravi'); expect(noPanel().textContent).not.toContain('Meera');
    fireEvent.change(screen.getByLabelText('Break'), { target: { value: 'EVENING' } });
    await waitFor(() => expect(noPanel().textContent).toContain('Meera'));
    expect(noPanel().textContent).not.toContain('MORNING');
    fireEvent.change(screen.getByLabelText('Break'), { target: { value: 'UNASSIGNED' } });
    await waitFor(() => expect(noPanel()).toBeNull());
  });
  it('Monthly and custom ranges include the No Snacks days in that range only', async () => {
    reportApi();
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Reports'));
    goTo('Reports');
    await waitFor(() => expect(noPanel()).not.toBeNull());
    fireEvent.change(screen.getByLabelText('Report period'), { target: { value: 'monthly' } });
    fireEvent.change(document.querySelector('input[type=month]'), { target: { value: '2026-10' } });
    await waitFor(() => expect(noPanel()?.textContent).toContain('5 Oct 2026'));
    expect(noPanel().querySelectorAll('tbody tr').length).toBe(1);
    expect(api.mock.calls.map(c => c[0])).toContain('/no-snacks?from=2026-10-01&to=2026-10-31');
    expect(screen.queryByText('Tea')).toBeNull();   // no snack records that month
    expect(stat('Snack records')).toBe('0');
  });
  it('a day with only No Snacks does not say "No report data" and shows 0 snacks', async () => {
    api.mockImplementation(async (path, opts) => (path.startsWith('/no-snacks') && !opts?.method ? [nsRows[0]] : path.startsWith('/records') && !opts?.method ? [] : defaultApi(path, opts)));
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Reports'));
    goTo('Reports');
    await waitFor(() => expect(noPanel()).not.toBeNull());
    expect(screen.queryByText('No report data for this period.')).toBeNull();
    expect(stat('Total quantity')).toBe('0'); expect(stat('Known expenses')).toMatch(/0\.00/);
  });
  it('if the No Snacks request fails the error is shown (not swallowed) and the normal report still loads', async () => {
    reportApi({ failNoSnacks: 'No Snacks is not installed in this Supabase project.' });
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Reports'));
    goTo('Reports');
    await screen.findByText('No Snacks is not installed in this Supabase project.');
    expect(screen.getByText('Tea')).toBeTruthy();
    expect(noPanel()).toBeNull();
  });
  it('USER still cannot reach Reports and never requests the admin report data', async () => {
    reportApi();
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    expect(navNames()).not.toContain('Reports');
  });
});

// ---- ADMIN Reports: Edit / Delete No Snacks ----
describe('ADMIN Reports: edit and delete No Snacks', () => {
  const nsBase = { noSnacks: true, snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null };
  const mk = (id, employeeId, employeeName, breakType, day = todayStr) => ({ ...nsBase, id, employeeId, employeeName, breakType, day, takenAt: `${day}T09:30:00+05:30` });
  const tea = { id: 1, employeeId: 1, employeeName: 'Asha', snackId: 1, snackName: 'Tea', quantity: 2, breakType: 'MORNING', unitPrice: 10, amount: 20, takenAt: `${todayStr}T10:00:00+05:30` };
  // stateful stand-in for the database
  const server = ({ failPut, failDelete } = {}) => {
    const st = { ns: [mk('ns-1', 2, 'Ravi', 'MORNING'), mk('ns-2', 3, 'Meera', 'EVENING')], calls: [] };
    api.mockImplementation(async (path, opts) => {
      if (path === '/employees') return [{ id: 1, name: 'Asha', active: true }, { id: 2, name: 'Ravi', active: true }, { id: 3, name: 'Meera', active: true }];
      if (path.startsWith('/no-snacks/') && opts?.method === 'PUT') {
        const body = JSON.parse(opts.body); st.calls.push(['PUT', path, body]);
        if (failPut) throw new Error(failPut);
        const i = st.ns.findIndex(n => `/no-snacks/${n.id}` === path);
        const names = { 1: 'Asha', 2: 'Ravi', 3: 'Meera' };
        st.ns[i] = { ...st.ns[i], employeeId: body.employeeId, employeeName: names[body.employeeId], day: body.day, breakType: body.breakType };
        return st.ns[i];
      }
      if (path.startsWith('/no-snacks/') && opts?.method === 'DELETE') {
        st.calls.push(['DELETE', path]);
        if (failDelete) throw new Error(failDelete);
        st.ns = st.ns.filter(n => `/no-snacks/${n.id}` !== path);
        return null;
      }
      if (path.startsWith('/no-snacks')) { const q = new URL(path, 'http://x').searchParams; return st.ns.filter(n => n.day >= q.get('from') && n.day <= q.get('to')); }
      if (path.startsWith('/records') && !opts?.method) return [tea];
      return defaultApi(path, opts);
    });
    return st;
  };
  const panel = () => document.querySelector('[data-testid="no-snacks-report"]');
  const rowOf = (name) => [...panel().querySelectorAll('tbody tr')].find(tr => tr.firstChild.textContent === name);
  const stat = (label) => [...document.querySelectorAll('.break-report-stats .stat-card')].find(c => c.textContent.includes(label)).querySelector('strong').textContent;
  const statsNow = () => ['Snack records', 'Total quantity', 'Employees', 'Known expenses'].map(stat);
  const open = async () => { await signInAs(admin); await waitFor(() => expect(navNames()).toContain('Reports')); goTo('Reports'); await waitFor(() => expect(panel()).not.toBeNull()); };
  const modal = () => document.querySelector('.edit-modal');

  it('every No Snacks row has Edit and Delete', async () => {
    server(); await open();
    for (const r of panel().querySelectorAll('tbody tr')) { expect(within(r).getByRole('button', { name: 'Edit' })).toBeTruthy(); expect(within(r).getByRole('button', { name: 'Delete' })).toBeTruthy(); }
  });
  it('Edit: the form shows the current employee/date/break; changing the break saves via Supabase, the report refreshes, other rows and the snack totals are unchanged', async () => {
    const st = server(); await open();
    const before = statsNow();
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Edit' }));
    expect(modal().textContent).toContain('Ravi'); expect(modal().textContent).toContain('MORNING break');
    const [emp, brk] = modal().querySelectorAll('select');
    await waitFor(() => expect(emp.options.length).toBe(3));
    expect(emp.value).toBe('2'); expect(modal().querySelector('input[type=date]').value).toBe(todayStr); expect(brk.value).toBe('MORNING');
    fireEvent.change(brk, { target: { value: 'EVENING' } });
    fireEvent.click(within(modal()).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('No Snacks record updated.');
    expect(st.calls).toEqual([['PUT', '/no-snacks/ns-1', { employeeId: 2, day: todayStr, breakType: 'EVENING' }]]);
    await waitFor(() => expect(rowOf('Ravi').textContent).toContain('EVENING'));
    expect(rowOf('Meera').textContent).toContain('EVENING');        // untouched
    expect(document.querySelector('.edit-modal')).toBeNull();
    expect(statsNow()).toEqual(before);                              // No Snacks never move the totals
  });
  it('Edit can change the employee and the date too', async () => {
    const st = server(); await open();
    fireEvent.click(within(rowOf('Meera')).getByRole('button', { name: 'Edit' }));
    const [emp] = modal().querySelectorAll('select');
    await waitFor(() => expect(emp.options.length).toBe(3));
    fireEvent.change(emp, { target: { value: '1' } });
    fireEvent.change(modal().querySelector('input[type=date]'), { target: { value: yesterdayStr } });
    fireEvent.click(within(modal()).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('No Snacks record updated.');
    expect(st.calls[0][2]).toEqual({ employeeId: 1, day: yesterdayStr, breakType: 'EVENING' });
    expect(api.mock.calls.map(c => c[0])).toContain(`/no-snacks?from=${todayStr}&to=${todayStr}`);
  });
  it('a duplicate / normal-snack conflict shows the real error, no success message, the row is unchanged and the form stays open', async () => {
    for (const msg of ['A No Snacks record for that employee, date and break already exists.', 'Snacks are already recorded for that employee, date and break, so No Snacks cannot be set there.']) {
      cleanup();
      const st = server({ failPut: msg }); await open();
      fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Edit' }));
      fireEvent.change(modal().querySelectorAll('select')[1], { target: { value: 'EVENING' } });
      fireEvent.click(within(modal()).getByRole('button', { name: 'Save changes' }));
      await screen.findByText(msg);
      expect(screen.queryByText('No Snacks record updated.')).toBeNull();
      expect(modal()).not.toBeNull();
      expect(rowOf('Ravi').textContent).toContain('MORNING');
      expect(st.ns[0].breakType).toBe('MORNING');
    }
  });
  it('Edit refuses an unchanged form and a future date locally (nothing sent)', async () => {
    const st = server(); await open();
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Edit' }));
    fireEvent.submit(modal());
    await screen.findByText('No changes to save.');
    fireEvent.change(modal().querySelector('input[type=date]'), { target: { value: '2999-01-01' } });
    fireEvent.submit(modal());
    await screen.findByText('The date cannot be in the future.');
    expect(st.calls.length).toBe(0);
  });
  it('Delete asks for confirmation, removes only the selected record, refreshes the report, and leaves the snack totals alone', async () => {
    const st = server(); await open();
    const before = statsNow();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Delete' }));
    await screen.findByText('No Snacks record deleted.');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/Morning No Snacks record for Ravi/);
    expect(st.calls).toEqual([['DELETE', '/no-snacks/ns-1']]);
    await waitFor(() => expect(rowOf('Ravi')).toBeUndefined());
    expect(rowOf('Meera')).toBeTruthy();
    expect(statsNow()).toEqual(before);
    confirm.mockRestore();
  });
  it('Delete does nothing when the confirmation is cancelled', async () => {
    const st = server(); await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Delete' }));
    expect(st.calls.length).toBe(0); expect(rowOf('Ravi')).toBeTruthy();
    confirm.mockRestore();
  });
  it('a failed delete shows the real error, no success message, and the row stays', async () => {
    server({ failDelete: 'No No Snacks record was deleted. Only an admin can delete it, or it no longer exists.' }); await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('Meera')).getByRole('button', { name: 'Delete' }));
    await screen.findByText('No No Snacks record was deleted. Only an admin can delete it, or it no longer exists.');
    expect(screen.queryByText('No Snacks record deleted.')).toBeNull();
    expect(rowOf('Meera')).toBeTruthy();
    confirm.mockRestore();
  });
  it('USER never gets admin Edit/Delete on No Snacks: no Reports page, and their own No Snacks row has no Delete', async () => {
    const own = { ...nsBase, id: 'ns-5', employeeId: 1, employeeName: 'Asha', breakType: 'MORNING', day: todayStr, takenAt: `${todayStr}T09:30:00+05:30` };
    api.mockImplementation(async (path, opts) => (path.startsWith('/no-snacks') && !opts?.method ? [own] : path.startsWith('/records') && !opts?.method ? [] : defaultApi(path, opts)));
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    expect(navNames()).not.toContain('Reports');
    goTo('Snack History');
    await waitFor(() => expect([...document.querySelectorAll('.table-wrap tbody')].pop()?.textContent).toContain('No Snacks'));
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(api.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(false);
  });
});

// ---- ADMIN Month Records: No Snacks Records section (separate from snack records and totals) ----
describe('ADMIN Month Records: No Snacks Records', () => {
  const nsBase = { noSnacks: true, snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null };
  const mk = (id, employeeId, employeeName, breakType, day) => ({ ...nsBase, id, employeeId, employeeName, breakType, day, takenAt: `${day}T09:30:00+05:30` });
  const tea = { id: 1, employeeId: 1, employeeName: 'Asha', snackId: 1, snackName: 'Tea', quantity: 2, breakType: 'MORNING', unitPrice: 10, amount: 20, takenAt: `${todayStr}T10:00:00+05:30` };
  const names = { 1: 'Asha', 2: 'Ravi', 3: 'Meera' };
  const monthOf = todayStr.slice(0, 7);
  const server = ({ failPut, failDelete, snackRecords = [tea] } = {}) => {
    const st = { ns: [mk('ns-1', 2, 'Ravi', 'MORNING', `${monthOf}-02`), mk('ns-2', 3, 'Meera', 'EVENING', `${monthOf}-03`), mk('ns-3', 2, 'Ravi', 'EVENING', '2026-10-05')], calls: [] };
    api.mockImplementation(async (path, opts) => {
      if (path === '/employees') return Object.entries(names).map(([id, name]) => ({ id: Number(id), name, active: true }));
      if (path.startsWith('/no-snacks/') && opts?.method === 'PUT') {
        const body = JSON.parse(opts.body); st.calls.push(['PUT', path, body]);
        if (failPut) throw new Error(failPut);
        const i = st.ns.findIndex(n => `/no-snacks/${n.id}` === path);
        st.ns[i] = { ...st.ns[i], employeeId: body.employeeId, employeeName: names[body.employeeId], day: body.day, breakType: body.breakType };
        return st.ns[i];
      }
      if (path.startsWith('/no-snacks/') && opts?.method === 'DELETE') {
        st.calls.push(['DELETE', path]);
        if (failDelete) throw new Error(failDelete);
        st.ns = st.ns.filter(n => `/no-snacks/${n.id}` !== path);
        return null;
      }
      if (path.startsWith('/no-snacks')) { const q = new URL(path, 'http://x').searchParams; return st.ns.filter(n => n.day >= q.get('from') && n.day <= q.get('to')); }
      if (path.startsWith('/records') && !opts?.method) return snackRecords.filter(r => inRange(r, new URL(path, 'http://x').searchParams));
      return defaultApi(path, opts);
    });
    return st;
  };
  const panel = () => document.querySelector('[data-testid="no-snacks-report"]');
  const rowOf = (name) => [...panel().querySelectorAll('tbody tr')].find(tr => tr.firstChild.textContent === name);
  const stat = (label) => [...document.querySelectorAll('.break-report-stats .stat-card')].find(c => c.textContent.includes(label)).querySelector('strong').textContent;
  const totals = () => ['Employees', 'Snack records', 'Total quantity', 'Known amount'].map(stat);
  const open = async () => { await signInAs(admin); await waitFor(() => expect(navNames()).toContain('Month Records')); goTo('Month Records'); await waitFor(() => expect(panel()).not.toBeNull()); };
  const modal = () => document.querySelector('.edit-modal');
  const setMonthTo = (v) => fireEvent.change(document.querySelector('input[type=month]'), { target: { value: v } });

  it('shows a separate "No Snacks Records" section with employee, date, break and status, plus the month count; the snack table and totals are unaffected', async () => {
    const st = server(); await open();
    expect(panel().querySelector('h2').textContent).toBe('No Snacks Records');
    expect(panel().textContent).toMatch(/2 No Snacks records in /);
    expect(panel().querySelector('.count-pill').textContent).toBe('2');
    const cells = [...panel().querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.textContent));
    const ravi = cells.find(c => c[0] === 'Ravi'), meera = cells.find(c => c[0] === 'Meera');
    expect(ravi.slice(2, 4)).toEqual(['MORNING', 'No Snacks']); expect(ravi[1]).toMatch(/2 \w+ 2026/);
    expect(meera.slice(2, 4)).toEqual(['EVENING', 'No Snacks']);
    // snack records: unchanged (1 record, quantity 2, ₹20) - No Snacks are not in the main table or totals
    expect(totals()).toEqual(['1', '1', '2', expect.stringMatching(/20\.00/)]);
    const main = document.querySelector('.table-wrap tbody');
    expect(main.textContent).toContain('Tea'); expect(main.textContent).not.toContain('No Snacks');
    expect(api.mock.calls.map(c => c[0])).toContain(`/no-snacks?from=${monthOf}-01&to=${monthOf}-${String(new Date(Date.UTC(+monthOf.slice(0, 4), +monthOf.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`);
    expect(st.calls.length).toBe(0);
  });
  it('switching the month refreshes BOTH the snack records and the No Snacks records (only that month)', async () => {
    server(); await open();
    setMonthTo('2026-10');
    await waitFor(() => expect(panel()?.textContent).toContain('5 Oct 2026'));
    expect(panel().querySelectorAll('tbody tr').length).toBe(1);
    expect(panel().textContent).toMatch(/1 No Snacks record in /);
    expect(panel().textContent).not.toContain('Meera');
    expect(document.body.textContent).not.toContain('TodayTea');
    expect(stat('Snack records')).toBe('0');
    setMonthTo(monthOf);
    await waitFor(() => expect(panel()?.querySelectorAll('tbody tr').length).toBe(2));
    expect(stat('Snack records')).toBe('1');
  });
  it('a month with ONLY No Snacks still shows them (and no misleading "no records" message)', async () => {
    server({ snackRecords: [] }); await open();
    expect(panel().querySelectorAll('tbody tr').length).toBe(2);
    expect(totals()).toEqual(['0', '0', '0', expect.stringMatching(/0\.00/)]);
    expect(screen.queryByText(new RegExp('^No records found for'))).toBeNull();
  });
  it('a month with no No Snacks shows a proper empty state in that section', async () => {
    server(); await open();
    setMonthTo('2025-03');
    await waitFor(() => expect(panel()?.textContent).toMatch(/No No Snacks records for March 2025\./));
    expect(panel().querySelector('.count-pill').textContent).toBe('0');
    expect(panel().querySelectorAll('tbody tr').length).toBe(0);
  });
  it('Edit changes the record through the same secure update, refreshes the month, and leaves the other row and the snack totals alone', async () => {
    const st = server(); await open();
    const before = totals();
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Edit' }));
    expect(modal().textContent).toContain('MORNING break');
    const brk = modal().querySelectorAll('select')[1];
    await waitFor(() => expect(modal().querySelectorAll('select')[0].options.length).toBe(3));
    fireEvent.change(brk, { target: { value: 'EVENING' } });
    fireEvent.click(within(modal()).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('No Snacks record updated.');
    expect(st.calls).toEqual([['PUT', '/no-snacks/ns-1', { employeeId: 2, day: `${monthOf}-02`, breakType: 'EVENING' }]]);
    await waitFor(() => expect(rowOf('Ravi').textContent).toContain('EVENING'));
    expect(rowOf('Meera').textContent).toContain('EVENING');
    expect(totals()).toEqual(before);
  });
  it('a failed edit (duplicate / conflict) shows the real error and nothing looks saved', async () => {
    const msg = 'A No Snacks record for that employee, date and break already exists.';
    const st = server({ failPut: msg }); await open();
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(modal().querySelectorAll('select')[1], { target: { value: 'EVENING' } });
    fireEvent.click(within(modal()).getByRole('button', { name: 'Save changes' }));
    await screen.findByText(msg);
    expect(screen.queryByText('No Snacks record updated.')).toBeNull();
    expect(modal()).not.toBeNull();
    expect(st.ns[0].breakType).toBe('MORNING');
  });
  it('Delete confirms first, removes only the selected record, refreshes the month, and leaves the snack totals alone', async () => {
    const st = server(); await open();
    const before = totals();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Delete' }));
    expect(st.calls.length).toBe(0);
    confirm.mockReturnValue(true);
    fireEvent.click(within(rowOf('Ravi')).getByRole('button', { name: 'Delete' }));
    await screen.findByText('No Snacks record deleted.');
    expect(st.calls).toEqual([['DELETE', '/no-snacks/ns-1']]);
    await waitFor(() => expect(panel().querySelectorAll('tbody tr').length).toBe(1));
    expect(panel().textContent).toContain('Meera'); expect(panel().textContent).toMatch(/1 No Snacks record in /);
    expect(totals()).toEqual(before);
    confirm.mockRestore();
  });
  it('a failed delete shows the real error and the row stays', async () => {
    server({ failDelete: 'No No Snacks record was deleted. Only an admin can delete it, or it no longer exists.' }); await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('Meera')).getByRole('button', { name: 'Delete' }));
    await screen.findByText('No No Snacks record was deleted. Only an admin can delete it, or it no longer exists.');
    expect(screen.queryByText('No Snacks record deleted.')).toBeNull();
    expect(rowOf('Meera')).toBeTruthy();
    confirm.mockRestore();
  });
  it('if the No Snacks request fails the error is shown (not swallowed) and the snack records still load', async () => {
    api.mockImplementation(async (path, opts) => { if (path.startsWith('/no-snacks')) throw new Error('No Snacks is not installed in this Supabase project.'); if (path.startsWith('/records') && !opts?.method) return [tea]; return defaultApi(path, opts); });
    await signInAs(admin);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await screen.findByText('No Snacks is not installed in this Supabase project.');
    expect(document.querySelector('.table-wrap tbody').textContent).toContain('Tea');
  });
  it('USER Month Records is unchanged: No Snacks stay inside their own table, with no admin section, Edit or Delete', async () => {
    const own = { ...mk('ns-9', 1, 'Asha', 'MORNING', todayStr) };
    api.mockImplementation(async (path, opts) => (path.startsWith('/no-snacks') && !opts?.method ? [own] : path.startsWith('/records') && !opts?.method ? [] : defaultApi(path, opts)));
    await signInAs(user);
    await waitFor(() => expect(navNames()).toContain('Month Records'));
    goTo('Month Records');
    await waitFor(() => expect(document.querySelector('.table-wrap tbody')?.textContent).toContain('No Snacks'));
    expect(panel()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

// ---- ADMIN submits No Snacks for any employee ----
describe('ADMIN submits No Snacks', () => {
  const names = { 1: 'Asha', 2: 'Ravi', 3: 'Meera' };
  const nsOf = (id, employeeId, breakType) => ({ noSnacks: true, id: `ns-${id}`, employeeId, employeeName: names[employeeId], snackName: 'No Snacks', quantity: null, unitPrice: null, amount: null, breakType, day: todayStr, takenAt: `${todayStr}T09:30:00+05:30` });
  const teaFor = (id, employeeId, breakType) => ({ id, employeeId, employeeName: names[employeeId], snackId: 1, snackName: 'Tea', quantity: 1, breakType, unitPrice: 10, amount: 10, takenAt: `${todayStr}T10:00:00+05:30` });
  // stateful stand-in for the database (also lets Reports / Month Records show what the admin submitted)
  const server = ({ ns = [], recs = [], failPost } = {}) => {
    const st = { ns: [...ns], recs: [...recs], posts: [], batches: [], nextId: 50 };
    api.mockImplementation(async (path, opts) => {
      if (path === '/employees') return Object.entries(names).map(([id, name]) => ({ id: Number(id), name, active: true }));
      if (path === '/snacks') return [{ id: 1, name: 'Tea', active: true, unitPrice: 10 }];
      if (path === '/no-snacks' && opts?.method === 'POST') {
        const body = JSON.parse(opts.body); st.posts.push(body);
        if (failPost) throw new Error(failPost);
        const row = nsOf(st.nextId++, body.employeeId, body.breakType); st.ns.push(row); return row;
      }
      if (path === '/records/batch' && opts?.method === 'POST') {
        const body = JSON.parse(opts.body); st.batches.push(body);
        const made = body.items.map(i => teaFor(st.nextId++, body.employeeId, body.breakType)); st.recs.push(...made); return made;
      }
      if (path.startsWith('/no-snacks') && !opts?.method) { const q = new URL(path, 'http://x').searchParams; return st.ns.filter(n => q.has('date') ? n.day === q.get('date') : n.day >= q.get('from') && n.day <= q.get('to')); }
      if (path.startsWith('/records') && !opts?.method) return st.recs.filter(r => inRange(r, new URL(path, 'http://x').searchParams));
      return defaultApi(path, opts);
    });
    return st;
  };
  const openTake = async () => { await signInAs(admin); await waitFor(() => expect(navNames().length).toBe(8)); goTo('Take Snacks'); await screen.findByRole('option', { name: 'No Snacks' }); await waitFor(() => expect(screen.getByLabelText('Employee').options.length).toBe(4)); return document.querySelector('.entry-form'); };
  const fill = (form, { emp, brk, snack }) => {
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: String(emp) } });
    fireEvent.change(screen.getByLabelText('Break type'), { target: { value: brk } });
    fireEvent.change(form.querySelector('.snack-item-row select'), { target: { value: snack } });
  };
  const submit = (form) => fireEvent.submit(form);
  const goTab = (name) => fireEvent.click(within(document.querySelector('nav')).getByText(name));

  it('the admin sees the No Snacks option and the employee dropdown (select employee, break, No Snacks)', async () => {
    server();
    await openTake();
    expect(screen.getByRole('option', { name: 'No Snacks' }).value).toBe('NO_SNACKS');
    expect(screen.getByLabelText('Employee').value).toBe('');
    expect(screen.getByRole('option', { name: 'Ravi' })).toBeTruthy();
  });
  it('Morning No Snacks for an employee is saved for that employee and break only', async () => {
    const st = server();
    const form = await openTake();
    fill(form, { emp: 2, brk: 'MORNING', snack: 'NO_SNACKS' });
    submit(form);
    await screen.findByText('No Snacks recorded for the Morning break.');
    expect(st.posts).toEqual([{ employeeId: 2, breakType: 'MORNING' }]);
    expect(st.batches.length).toBe(0);
  });
  it('Evening No Snacks for a different employee, and both breaks / several employees are independent', async () => {
    const st = server();
    const form = await openTake();
    fill(form, { emp: 3, brk: 'EVENING', snack: 'NO_SNACKS' }); submit(form);
    await waitFor(() => expect(st.posts.length).toBe(1));
    fill(form, { emp: 3, brk: 'MORNING', snack: 'NO_SNACKS' }); submit(form);
    await waitFor(() => expect(st.posts.length).toBe(2));
    fill(form, { emp: 2, brk: 'EVENING', snack: 'NO_SNACKS' }); submit(form);
    await waitFor(() => expect(st.posts.length).toBe(3));
    expect(st.posts).toEqual([{ employeeId: 3, breakType: 'EVENING' }, { employeeId: 3, breakType: 'MORNING' }, { employeeId: 2, breakType: 'EVENING' }]);
  });
  it('a duplicate is blocked only for the SELECTED employee and break (another employee is still allowed)', async () => {
    const st = server({ ns: [nsOf(1, 2, 'MORNING')] });
    const form = await openTake();
    fill(form, { emp: 2, brk: 'MORNING', snack: 'NO_SNACKS' }); submit(form);
    await screen.findByText('You have already submitted No Snacks for the Morning break today.');
    expect(st.posts.length).toBe(0);
    fill(form, { emp: 3, brk: 'MORNING', snack: 'NO_SNACKS' }); submit(form);
    await waitFor(() => expect(st.posts).toEqual([{ employeeId: 3, breakType: 'MORNING' }]));
  });
  it("No Snacks is refused where THAT employee already has snacks for the break; the other break and other employees are fine", async () => {
    const st = server({ recs: [teaFor(9, 2, 'MORNING')] });
    const form = await openTake();
    fill(form, { emp: 2, brk: 'MORNING', snack: 'NO_SNACKS' }); submit(form);
    await screen.findByText('You have already recorded snacks for the Morning break today, so No Snacks cannot be submitted for it.');
    expect(st.posts.length).toBe(0);
    fill(form, { emp: 2, brk: 'EVENING', snack: 'NO_SNACKS' }); submit(form);
    await waitFor(() => expect(st.posts.length).toBe(1));
    fill(form, { emp: 3, brk: 'MORNING', snack: 'NO_SNACKS' }); submit(form);
    await waitFor(() => expect(st.posts.length).toBe(2));
  });
  it('snacks are refused for an employee/break that already has No Snacks, otherwise normal submission is unchanged (batch POST, price/quantity untouched)', async () => {
    const st = server({ ns: [nsOf(1, 2, 'MORNING')] });
    const form = await openTake();
    fill(form, { emp: 2, brk: 'MORNING', snack: '1' }); submit(form);
    await screen.findByText('You have already submitted No Snacks for the Morning break today, so snacks cannot be added to it.');
    expect(st.batches.length).toBe(0);
    fill(form, { emp: 2, brk: 'EVENING', snack: '1' }); submit(form);
    await screen.findByText('1 snack record saved.');
    expect(st.batches).toEqual([{ employeeId: 2, breakType: 'EVENING', items: [{ snackId: 1, quantity: 1 }] }]);
    expect(st.posts.length).toBe(0);
  });
  it('if Supabase refuses the insert (e.g. the migration is not installed) the real error shows and there is no success message', async () => {
    const msg = 'Supabase denied this No Snacks entry. Users can submit only for themselves; admins need database/migrations/2026-11-29-no-snacks-admin-submit.sql run in the SQL Editor.';
    const st = server({ failPost: msg });
    const form = await openTake();
    fill(form, { emp: 2, brk: 'MORNING', snack: 'NO_SNACKS' }); submit(form);
    await screen.findByText(msg);
    expect(screen.queryByText(/No Snacks recorded for/)).toBeNull();
    expect(st.ns.length).toBe(0);
  });
  it("what the admin submitted shows up in Reports and in Month Records (with employee, date and break)", async () => {
    const st = server();
    const form = await openTake();
    fill(form, { emp: 2, brk: 'MORNING', snack: 'NO_SNACKS' }); submit(form);
    await screen.findByText('No Snacks recorded for the Morning break.');
    goTab('Reports');
    await waitFor(() => expect(document.querySelector('[data-testid="no-snacks-report"]')).not.toBeNull());
    let cells = [...document.querySelectorAll('[data-testid="no-snacks-report"] tbody tr')].map(tr => [...tr.children].map(c => c.textContent));
    expect(cells.length).toBe(1); expect(cells[0][0]).toBe('Ravi'); expect(cells[0].slice(2, 4)).toEqual(['MORNING', 'No Snacks']);
    goTab('Month Records');
    await waitFor(() => expect(document.querySelector('[data-testid="no-snacks-report"]')?.textContent).toContain('Ravi'));
    expect(document.querySelector('[data-testid="no-snacks-report"] .count-pill').textContent).toBe('1');
    expect(st.ns.length).toBe(1);
  });
  it('USER stays limited to themselves: no employee dropdown, and the request carries their own employee id', async () => {
    const st = server();
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(4));
    goTab('Take Snacks');
    await screen.findByRole('option', { name: 'No Snacks' });
    await waitFor(() => expect(document.querySelector('.own-employee b')?.textContent).toBe('Asha'));
    expect(screen.queryByLabelText('Employee')).toBeNull();
    const form = document.querySelector('.entry-form');
    fireEvent.change(screen.getByLabelText('Break type'), { target: { value: 'EVENING' } });
    fireEvent.change(form.querySelector('.snack-item-row select'), { target: { value: 'NO_SNACKS' } });
    submit(form);
    await screen.findByText('No Snacks recorded for the Evening break.');
    expect(st.posts).toEqual([{ employeeId: 1, breakType: 'EVENING' }]);
  });
});
