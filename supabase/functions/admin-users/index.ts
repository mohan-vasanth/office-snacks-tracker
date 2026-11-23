// Admin-only account management for Office Snacks Tracker.
// Runs server-side with the service-role key that Supabase injects as SUPABASE_SERVICE_ROLE_KEY.
// That key is never sent to, or stored in, the frontend. Passwords are handed to Supabase Auth
// (which hashes them) and are never stored or logged by this function.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// bcrypt (used by Supabase Auth) only considers the first 72 bytes, so limit bytes, not characters.
const passwordProblem = (value: unknown) =>
  typeof value !== 'string' || value.length < 10 || new TextEncoder().encode(value).length > 72
    ? 'Temporary password must be at least 10 characters and at most 72 bytes.'
    : null;
// Auth error text (e.g. "Password should contain...") is safe to show; log details server-side only.
const authFailure = (what: string, error: { message?: string; status?: number } | null) => {
  console.error(`${what} failed`, error?.status, error?.message);
  return `${what} failed: ${error?.message ?? 'unknown error'}`;
};
// A database error is NEVER reported as "not found": a failed read says nothing about whether the row exists.
// 42501 = permission denied, i.e. the service_role grants migration has not been applied.
const dbFailure = (what: string, error: { code?: string; message?: string }) => {
  console.error(`${what} failed`, error.code, error.message);
  const hint = error.code === '42501'
    ? ' The service role is missing a table privilege: apply database/migrations/2026-11-23-service-role-grants.sql.'
    : '';
  return json({ error: `${what} failed: ${error.message ?? 'database error'}.${hint}` }, 500);
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'Function is not configured.' }, 500);

  // 1. Authenticate the caller and require an active ADMIN (checked in the database, not in the request).
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in required.' }, 401);
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: 'Your session is not valid. Sign in again.' }, 401);
  const { data: role, error: roleError } = await caller.rpc('current_office_role');
  if (roleError || role !== 'admin') return json({ error: 'Admin access required.' }, 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  // Only USER accounts are managed here: admins cannot be reset or deactivated (no self-lockout).
  const loadUserTarget = async (userId: unknown): Promise<{ userId?: string; error?: Response }> => {
    if (typeof userId !== 'string' || !uuidPattern.test(userId)) return { error: json({ error: 'Invalid user.' }, 400) };
    const { data, error } = await admin.from('user_profiles').select('user_id, role').eq('user_id', userId).maybeSingle();
    if (error) return { error: dbFailure('Looking up the user account', error) };
    if (!data) return { error: json({ error: 'User account not found.' }, 404) };
    if (data.role !== 'user') return { error: json({ error: 'Only USER accounts can be managed here.' }, 403) };
    return { userId };
  };

  switch (body.action) {
    case 'create': {
      const employeeId = Number(body.employeeId);
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!Number.isInteger(employeeId) || employeeId < 1) return json({ error: 'Choose an employee.' }, 400);
      if (!emailPattern.test(email) || email.length > 254) return json({ error: 'Enter a valid email address.' }, 400);
      const problem = passwordProblem(body.password);
      if (problem) return json({ error: problem }, 400);

      const { data: employee, error: employeeError } = await admin.from('employees').select('id, active').eq('id', employeeId).maybeSingle();
      if (employeeError) return dbFailure('Looking up the employee', employeeError);
      if (!employee) return json({ error: 'Employee not found.' }, 404);
      if (!employee.active) return json({ error: 'This employee is inactive. Activate them first.' }, 400);
      const { data: existing, error: existingError } = await admin.from('user_profiles').select('user_id').eq('employee_id', employeeId).maybeSingle();
      if (existingError) return dbFailure('Checking for an existing login', existingError);
      if (existing) return json({ error: 'This employee already has a login.' }, 409);

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password: body.password as string,
        email_confirm: true,
      });
      if (createError || !created?.user) {
        const taken = /already|registered|exists/i.test(createError?.message ?? '');
        return json({ error: taken ? 'That email address already has an account.' : authFailure('Creating the login', createError) }, taken ? 409 : 400);
      }
      const { error: registerError } = await admin.rpc('service_register_user', {
        p_user_id: created.user.id,
        p_employee_id: employeeId,
      });
      if (registerError) {
        await admin.auth.admin.deleteUser(created.user.id); // roll back the Auth user
        const duplicate = registerError.code === '23505';
        console.error('service_register_user failed', registerError.code, registerError.message);
        return json(
          { error: duplicate ? 'This employee already has a login.' : `Could not link the login to the employee: ${registerError.message}` },
          duplicate ? 409 : 500,
        );
      }
      return json({ userId: created.user.id, email });
    }

    case 'reset-password': {
      const target = await loadUserTarget(body.userId);
      if (target.error) return target.error;
      const problem = passwordProblem(body.password);
      if (problem) return json({ error: problem }, 400);
      const { error: updateError } = await admin.auth.admin.updateUserById(target.userId!, { password: body.password as string });
      if (updateError) return json({ error: authFailure('Resetting the password', updateError) }, 400);
      const { error: flagError } = await admin.rpc('service_flag_password_reset', { p_user_id: target.userId });
      if (flagError) return json({ error: `Password was changed but the change-on-next-login flag failed (${flagError.message}). Run the reset again.` }, 500);
      return json({ userId: target.userId });
    }

    case 'set-active': {
      const target = await loadUserTarget(body.userId);
      if (target.error) return target.error;
      if (typeof body.active !== 'boolean') return json({ error: 'active must be true or false.' }, 400);
      if (target.userId === userData.user.id) return json({ error: 'You cannot change your own account.' }, 403);
      // Deactivate in the profile first so RLS denies access immediately, then ban the Auth login.
      if (body.active) {
        const { error: unban } = await admin.auth.admin.updateUserById(target.userId!, { ban_duration: 'none' });
        if (unban) return json({ error: authFailure('Re-enabling the login', unban) }, 500);
      }
      const { error: profileError } = await admin.from('user_profiles').update({ active: body.active }).eq('user_id', target.userId);
      if (profileError) return dbFailure('Updating the account', profileError);
      if (!body.active) {
        const { error: ban } = await admin.auth.admin.updateUserById(target.userId!, { ban_duration: '876000h' });
        if (ban) return json({ error: `${authFailure('Blocking the login', ban)}. The account is already blocked from all data; retry to ban the login.` }, 500);
      }
      return json({ userId: target.userId, active: body.active });
    }

    case 'update-email': {
      const target = await loadUserTarget(body.userId);
      if (target.error) return target.error;
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!emailPattern.test(email) || email.length > 254) return json({ error: 'Enter a valid email address.' }, 400);
      const { error: emailError } = await admin.auth.admin.updateUserById(target.userId!, { email, email_confirm: true });
      if (emailError) {
        const taken = /already|registered|exists/i.test(emailError.message ?? '');
        return json({ error: taken ? 'That email address already has an account.' : authFailure('Updating the email', emailError) }, taken ? 409 : 400);
      }
      return json({ userId: target.userId, email });
    }

    default:
      return json({ error: 'Unknown action.' }, 400);
  }
});
