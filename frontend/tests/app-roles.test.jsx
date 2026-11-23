// Setup (not part of the app build): in an empty scratch folder run
//   npm i vitest@2 jsdom @testing-library/react@16 react@18.3.1 react-dom@18.3.1
// add a vitest config that aliases react/react-dom to that folder, inlines @testing-library, react, react-dom and lucide-react,
// copy this file next to it, fix the absolute paths below, then: npx vitest run
// Behaviour tests for the real App.jsx with supabaseClient/supabaseData mocked. NOT a live Supabase test.
import React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

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
  it('Snack History has no Edit/Delete/CSV/PDF controls', async () => {
    await signInAs(user);
    await waitFor(() => expect(navNames().length).toBe(3));
    fireEvent.click(within(document.querySelector('nav')).getByText('Snack History'));
    await screen.findByText('Snack records');
    expect(screen.queryByText('Export CSV')).toBeNull();
    expect(screen.queryByText('Download PDF')).toBeNull();
    expect(screen.queryByText('ACTION')).toBeNull();
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
