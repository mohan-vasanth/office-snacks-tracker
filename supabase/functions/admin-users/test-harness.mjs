// Local harness: runs the REAL index.ts handler against an in-memory mock of supabase-js.
// It verifies the function's control flow (auth, admin check, validation, ordering, rollback).
// It does NOT talk to Supabase. Run from the repo root:  node supabase/functions/admin-users/test-harness.mjs
// (needs esbuild, e.g. from frontend/node_modules)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(join(process.cwd(), 'frontend/package.json'));
const esbuild = require('esbuild');

const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';
const USER_ID = '00000000-0000-4000-8000-00000000000a';
const OTHER_ID = '00000000-0000-4000-8000-00000000000b';

const dir = mkdtempSync(join(tmpdir(), 'admin-users-'));
const src = readFileSync('supabase/functions/admin-users/index.ts', 'utf8').replace("'npm:@supabase/supabase-js@2'", "'./mock.mjs'");
writeFileSync(join(dir, 'index.mjs'), esbuild.transformSync(src, { loader: 'ts', format: 'esm' }).code);
writeFileSync(join(dir, 'mock.mjs'), `
export const state = { log: [], failRegister: null, createError: null, banError: null, dbErrors: [], privileges: null };
// COLUMN-level privilege model, like Postgres. privileges === null: everything is allowed. Otherwise { table: { select: [cols], update: [cols] } }.
//  - a SELECT needs SELECT on every selected column AND on every column used in WHERE (a bare select() means "*", which needs all columns);
//  - an UPDATE needs UPDATE on every column it sets AND SELECT on every WHERE column.
// A denied call returns the error PostgREST returns: code 42501 (Postgres says "permission denied for table X" for column denials too).
function denied(table, op, cols, whereCols) {
  if (state.privileges === null) return null;
  const p = state.privileges[table] || {};
  const sel = p.select || [], upd = p.update || [];
  const okWhere = whereCols.every(c => sel.includes(c));
  const okOp = op === 'update' ? cols.every(c => upd.includes(c)) : cols.every(c => sel.includes(c));
  return okWhere && okOp ? null : { code: '42501', message: 'permission denied for table ' + table, details: null, hint: null };
}
export const db = { profiles: [], employees: [] };
const tokens = { 'admin-token': { id: '${ADMIN_ID}', role: 'admin' }, 'user-token': { id: '${USER_ID}', role: 'user' }, 'inactive-token': { id: '${OTHER_ID}', role: null } };
function query(table) {
  let rows = table === 'employees' ? db.employees : db.profiles, filters = [], patch = null, cols = ['*'];
  const api = {
    select(c) { cols = String(c).split(',').map(s => s.trim()); return api; }, eq(k, v) { filters.push([k, v]); return api; },
    update(p) { patch = p; return api; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error ?? null }); },
  };
  function run() {
    const op = patch ? 'update' : 'select';
    const injected = state.dbErrors.find(e => e.table === table && e.op === op);
    const err = injected ? injected.error : denied(table, op, op === 'update' ? Object.keys(patch) : cols, filters.map(f => f[0]));
    if (err) { state.log.push('dberror:' + table + ':' + op); return { data: null, error: err }; }
    const m = rows.filter(r => filters.every(([k, v]) => r[k] === v));
    if (patch) { state.log.push('update:' + table + ':' + JSON.stringify(patch)); m.forEach(r => Object.assign(r, patch)); return { data: m, error: null }; }
    return { data: m, error: null };
  }
  return api;
}
export function createClient(url, key, opts) {
  if (key === 'SERVICE') {
    return {
      from: query,
      rpc: async (name, args) => { state.log.push('rpc:' + name); if (name === 'service_register_user' && state.failRegister) return { error: state.failRegister }; return { error: null }; },
      auth: { admin: {
        createUser: async (a) => { state.log.push('createUser:' + a.email); if (state.createError) return { data: null, error: state.createError }; return { data: { user: { id: '00000000-0000-4000-8000-0000000000cc' } }, error: null }; },
        deleteUser: async (id) => { state.log.push('deleteUser'); return { error: null }; },
        updateUserById: async (id, attrs) => { state.log.push('updateUserById:' + JSON.stringify(Object.keys(attrs)) + (attrs.ban_duration ? ':' + attrs.ban_duration : '')); if (attrs.ban_duration && attrs.ban_duration !== 'none' && state.banError) return { error: state.banError }; return { error: null }; },
      } },
    };
  }
  const token = (opts?.global?.headers?.Authorization || '').replace('Bearer ', '');
  return {
    auth: { getUser: async (t) => tokens[t] ? { data: { user: { id: tokens[t].id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } } },
    rpc: async (name) => { state.log.push('caller-rpc:' + name); return { data: tokens[token]?.role ?? null, error: null }; },
  };
}
`);
let handler;
globalThis.Deno = { env: { get: k => ({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'ANON', SUPABASE_SERVICE_ROLE_KEY: 'SERVICE' })[k] }, serve: h => { handler = h; } };
await import(pathToFileURL(join(dir, 'index.mjs')).href);
const { state, db } = await import(pathToFileURL(join(dir, 'mock.mjs')).href);

let pass = 0, fail = 0; const out = [];
const ok = (n, c, d = '') => { (c ? pass++ : fail++); out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const reset = () => { state.log.length = 0; state.failRegister = null; state.createError = null; state.banError = null; state.dbErrors = []; state.privileges = null;
  db.employees.length = 0; db.profiles.length = 0;
  db.employees.push({ id: 1, active: true }, { id: 2, active: true }, { id: 3, active: false });
  db.profiles.push({ user_id: ADMIN_ID, role: 'admin', employee_id: null, active: true }, { user_id: USER_ID, role: 'user', employee_id: 1, active: true }, { user_id: OTHER_ID, role: 'user', employee_id: 2, active: true }); };
const call = async (token, body, method = 'POST') => {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = `Bearer ${token}`;
  const res = await handler(new Request('https://x/functions/v1/admin-users', { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }));
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const noPrivileged = () => !state.log.some(l => /^(createUser|deleteUser|updateUserById|rpc:|update:)/.test(l));

reset();
let r = await handler(new Request('https://x', { method: 'OPTIONS' })); ok('OPTIONS preflight allowed', r.status === 200);
r = await call(null, {}, 'GET'); ok('GET rejected (405)', r.status === 405);
reset(); r = await call(null, { action: 'create' }); ok('No Authorization header -> 401, nothing privileged run', r.status === 401 && noPrivileged(), String(r.status));
reset(); r = await call('forged', { action: 'create' }); ok('Invalid/forged token -> 401, nothing privileged run', r.status === 401 && noPrivileged());
reset(); r = await call('user-token', { action: 'create', employeeId: 2, email: 'x@y.com', password: 'LongEnough123', role: 'admin', callerRole: 'admin' });
ok('USER token -> 403 even if body claims role admin', r.status === 403 && noPrivileged(), String(r.status));
reset(); r = await call('inactive-token', { action: 'set-active', userId: OTHER_ID, active: false });
ok('Inactive/must-change caller (role NULL) -> 403', r.status === 403 && noPrivileged());
reset(); r = await call('admin-token', { action: 'nope' }); ok('Unknown action -> 400', r.status === 400);

reset(); r = await call('admin-token', { action: 'create', employeeId: 2 , email: 'bad', password: 'LongEnough123' }); ok('create: invalid email -> 400', r.status === 400);
r = await call('admin-token', { action: 'create', employeeId: 2, email: 'a@b.com', password: 'short' }); ok('create: short password -> 400', r.status === 400);
r = await call('admin-token', { action: 'create', employeeId: 2, email: 'a@b.com', password: 'é'.repeat(40) }); ok('create: >72-byte password -> 400', r.status === 400);
r = await call('admin-token', { action: 'create', employeeId: 99, email: 'a@b.com', password: 'LongEnough123' }); ok('create: unknown employee -> 404', r.status === 404);
r = await call('admin-token', { action: 'create', employeeId: 3, email: 'a@b.com', password: 'LongEnough123' }); ok('create: inactive employee -> 400', r.status === 400);
reset(); r = await call('admin-token', { action: 'create', employeeId: 1, email: 'a@b.com', password: 'LongEnough123' }); ok('create: employee already has a login -> 409, no Auth user created', r.status === 409 && !state.log.some(l => l.startsWith('createUser')));
reset(); db.employees.push({ id: 4, active: true });
r = await call('admin-token', { action: 'create', employeeId: 4, email: ' New@B.com ', password: 'LongEnough123' });
ok('create: success -> 200, email normalised, register helper called', r.status === 200 && r.json.email === 'new@b.com' && state.log.includes('createUser:new@b.com') && state.log.includes('rpc:service_register_user'), JSON.stringify(r.json));
ok('create: response never contains the password or service key', !/LongEnough123|SERVICE/.test(r.text));
reset(); db.employees.push({ id: 4, active: true }); state.createError = { message: 'A user with this email address has already been registered', status: 422 };
r = await call('admin-token', { action: 'create', employeeId: 4, email: 'dup@b.com', password: 'LongEnough123' }); ok('create: duplicate email -> 409', r.status === 409);
reset(); db.employees.push({ id: 4, active: true }); state.createError = { message: 'Password is known to be weak', status: 422 };
r = await call('admin-token', { action: 'create', employeeId: 4, email: 'w@b.com', password: 'LongEnough123' }); ok('create: real Auth error text is surfaced (not hidden)', r.status === 400 && /weak/.test(r.json.error), r.json?.error);
reset(); db.employees.push({ id: 4, active: true }); state.failRegister = { code: '23505', message: 'duplicate' };
r = await call('admin-token', { action: 'create', employeeId: 4, email: 'r@b.com', password: 'LongEnough123' }); ok('create: DB duplicate -> Auth user rolled back (deleteUser) + 409', r.status === 409 && state.log.includes('deleteUser'));

reset(); r = await call('admin-token', { action: 'reset-password', userId: 'not-a-uuid', password: 'LongEnough123' }); ok('reset: invalid userId -> 400', r.status === 400);
r = await call('admin-token', { action: 'reset-password', userId: ADMIN_ID, password: 'LongEnough123' }); ok('reset: cannot target an ADMIN -> 403', r.status === 403 && noPrivileged());
r = await call('admin-token', { action: 'reset-password', userId: '00000000-0000-4000-8000-0000000000ee', password: 'LongEnough123' }); ok('reset: unknown user -> 404', r.status === 404);
r = await call('admin-token', { action: 'reset-password', userId: USER_ID, password: 'short' }); ok('reset: short password -> 400', r.status === 400 && noPrivileged());
r = await call('admin-token', { action: 'reset-password', userId: USER_ID, password: 'LongEnough123' });
ok('reset: success sets password THEN flags change-on-login', r.status === 200 && state.log.indexOf('updateUserById:["password"]') < state.log.indexOf('rpc:service_flag_password_reset') && state.log.includes('rpc:service_flag_password_reset'), state.log.join(' | '));
ok('reset: response never contains the password', !/LongEnough123/.test(r.text));

reset(); r = await call('admin-token', { action: 'set-active', userId: ADMIN_ID, active: false }); ok('set-active: cannot target an ADMIN -> 403', r.status === 403 && noPrivileged());
r = await call('admin-token', { action: 'set-active', userId: USER_ID, active: 'no' }); ok('set-active: non-boolean -> 400', r.status === 400);
reset(); r = await call('admin-token', { action: 'set-active', userId: USER_ID, active: false });
const iProfile = state.log.findIndex(l => l.startsWith('update:user_profiles')), iBan = state.log.findIndex(l => l.includes('876000h'));
ok('set-active(false): profile blocked FIRST, then Auth ban', r.status === 200 && iProfile >= 0 && iBan > iProfile && db.profiles.find(p => p.user_id === USER_ID).active === false, state.log.join(' | '));
reset(); db.profiles.find(p => p.user_id === USER_ID).active = false; r = await call('admin-token', { action: 'set-active', userId: USER_ID, active: true });
const iUnban = state.log.findIndex(l => l.includes(':none')), iAct = state.log.findIndex(l => l.startsWith('update:user_profiles'));
ok('set-active(true): Auth unban then profile re-enabled', r.status === 200 && iUnban >= 0 && iAct > iUnban && db.profiles.find(p => p.user_id === USER_ID).active === true);
reset(); state.banError = { message: 'boom', status: 500 }; r = await call('admin-token', { action: 'set-active', userId: USER_ID, active: false });
ok('set-active(false): ban failure reported honestly, profile already blocked', r.status === 500 && /boom/.test(r.json.error) && db.profiles.find(p => p.user_id === USER_ID).active === false, r.json?.error);

reset(); r = await call('admin-token', { action: 'update-email', userId: USER_ID, email: 'nope' }); ok('update-email: invalid email -> 400', r.status === 400);
r = await call('admin-token', { action: 'update-email', userId: ADMIN_ID, email: 'a@b.com' }); ok('update-email: cannot target an ADMIN -> 403', r.status === 403);
r = await call('admin-token', { action: 'update-email', userId: USER_ID, email: 'Fresh@B.com' }); ok('update-email: success', r.status === 200 && r.json.email === 'fresh@b.com');
reset(); r = await call('user-token', { action: 'update-email', userId: OTHER_ID, email: 'x@b.com' }); ok('update-email as USER -> 403', r.status === 403 && noPrivileged());

// ---------------------------------------------------------------------------------------------------------------------
// Database errors must never be reported as "not found" (production defect found in review: service_role had no table
// privileges, and the function ignored the resulting 42501 and answered "Employee not found" / "User account not found").
// ---------------------------------------------------------------------------------------------------------------------
// = the COLUMN-level grants in database/migrations/2026-11-23-service-role-grants.sql
const MINIMUM_GRANTS = { employees: { select: ['id', 'active'] }, user_profiles: { select: ['user_id', 'role', 'employee_id'], update: ['active'] } };
const UNKNOWN_USER = '00000000-0000-4000-8000-0000000000ee';
const noBan = () => !state.log.some(l => l.includes('876000h'));
const asAdmin = body => call('admin-token', body);

// -- permission errors (the production situation before the grants migration: service_role may read nothing) --
reset(); state.privileges = {}; db.employees.push({ id: 4, active: true });
r = await asAdmin({ action: 'create', employeeId: 4, email: 'a@b.com', password: 'LongEnough123' });
ok('PERM create: employees unreadable -> 500 with the real error, NOT "Employee not found"', r.status === 500 && /permission denied for table employees/.test(r.json.error) && !/not found/i.test(r.json.error), r.json?.error);
ok('PERM create: the error tells the admin to apply the service-role grants migration', /2026-11-23-service-role-grants\.sql/.test(r.json.error));
ok('PERM create: no Auth user was created', noPrivileged());
reset(); state.privileges = { employees: MINIMUM_GRANTS.employees }; db.employees.push({ id: 4, active: true });
r = await asAdmin({ action: 'create', employeeId: 4, email: 'a@b.com', password: 'LongEnough123' });
ok('PERM create: user_profiles unreadable -> 500 (NOT treated as "no existing login"), no Auth user created', r.status === 500 && /Checking for an existing login failed: permission denied for table user_profiles/.test(r.json.error) && noPrivileged(), r.json?.error);
for (const [name, body] of [['reset-password', { action: 'reset-password', userId: USER_ID, password: 'LongEnough123' }], ['set-active', { action: 'set-active', userId: USER_ID, active: false }], ['update-email', { action: 'update-email', userId: USER_ID, email: 'n@b.com' }]]) {
  reset(); state.privileges = {};
  r = await asAdmin(body);
  ok(`PERM ${name}: profile unreadable -> 500 with the real error, NOT "User account not found" (404)`, r.status === 500 && /Looking up the user account failed: permission denied for table user_profiles/.test(r.json.error) && !/not found/i.test(r.json.error) && noPrivileged(), `${r.status} ${r.json?.error}`);
}
reset(); state.privileges = { user_profiles: { select: MINIMUM_GRANTS.user_profiles.select } };   // may read, may NOT update
r = await asAdmin({ action: 'set-active', userId: USER_ID, active: false });
ok('PERM set-active(false): profile update denied -> 500 with grants hint, and the Auth ban is NOT attempted', r.status === 500 && /Updating the account failed: permission denied/.test(r.json.error) && /service-role-grants/.test(r.json.error) && noBan(), r.json?.error);
ok('PERM set-active(false): the profile is unchanged (still active)', db.profiles.find(p => p.user_id === USER_ID).active === true);
reset(); state.privileges = { user_profiles: { select: MINIMUM_GRANTS.user_profiles.select } }; db.profiles.find(p => p.user_id === USER_ID).active = false;
r = await asAdmin({ action: 'set-active', userId: USER_ID, active: true });
ok('PERM set-active(true): update denied -> 500 (not silently "ok"); account stays inactive', r.status === 500 && db.profiles.find(p => p.user_id === USER_ID).active === false, r.json?.error);
reset(); state.dbErrors = [{ table: 'employees', op: 'select', error: { code: 'XX000', message: 'connection reset by peer' } }]; db.employees.push({ id: 4, active: true });
r = await asAdmin({ action: 'create', employeeId: 4, email: 'a@b.com', password: 'LongEnough123' });
ok('DB error other than permission (connection reset) -> 500 with its message, no grants hint, not "not found"', r.status === 500 && /connection reset by peer/.test(r.json.error) && !/grants/.test(r.json.error) && !/not found/i.test(r.json.error) && noPrivileged(), r.json?.error);
reset(); state.dbErrors = [{ table: 'user_profiles', op: 'select', error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }];
r = await asAdmin({ action: 'set-active', userId: USER_ID, active: false });
ok('PostgREST error code on a profile lookup is surfaced as 500, never as 404', r.status === 500 && /multiple \(or no\) rows/.test(r.json.error), `${r.status}`);

// -- genuinely missing rows are still reported as such (privileges fully granted) --
reset(); state.privileges = MINIMUM_GRANTS;
r = await asAdmin({ action: 'create', employeeId: 99, email: 'a@b.com', password: 'LongEnough123' });
ok('MISSING employee (readable, no such id) -> 404 "Employee not found."', r.status === 404 && r.json.error === 'Employee not found.' && noPrivileged());
for (const [name, body] of [['reset-password', { action: 'reset-password', userId: UNKNOWN_USER, password: 'LongEnough123' }], ['set-active', { action: 'set-active', userId: UNKNOWN_USER, active: false }], ['update-email', { action: 'update-email', userId: UNKNOWN_USER, email: 'n@b.com' }]]) {
  reset(); state.privileges = MINIMUM_GRANTS;
  r = await asAdmin(body);
  ok(`MISSING profile on ${name} (readable, no such user) -> 404 "User account not found."`, r.status === 404 && r.json.error === 'User account not found.' && noPrivileged(), `${r.status} ${r.json?.error}`);
}
reset(); state.privileges = MINIMUM_GRANTS; db.employees.push({ id: 5, active: true }); db.profiles.push({ user_id: '00000000-0000-4000-8000-0000000000dd', role: 'user', employee_id: 5, active: true });
r = await asAdmin({ action: 'create', employeeId: 5, email: 'a@b.com', password: 'LongEnough123' });
ok('EXISTING login for the employee is still a 409 conflict (readable profile found)', r.status === 409 && /already has a login/.test(r.json.error) && noPrivileged());
reset(); state.privileges = MINIMUM_GRANTS; db.profiles.push({ user_id: '00000000-0000-4000-8000-0000000000dc', role: 'admin', employee_id: null, active: true });
r = await asAdmin({ action: 'reset-password', userId: '00000000-0000-4000-8000-0000000000dc', password: 'LongEnough123' });
ok('an ADMIN profile is still refused (403), not confused with a missing one', r.status === 403 && noPrivileged());

// -- successful operations with EXACTLY the minimum grants: every table call the function makes must fit inside them --
reset(); state.privileges = MINIMUM_GRANTS; db.employees.push({ id: 4, active: true });
r = await asAdmin({ action: 'create', employeeId: 4, email: ' New@B.com ', password: 'LongEnough123' });
ok('OK create under the minimum grants -> 200, Auth user created and linked', r.status === 200 && r.json.email === 'new@b.com' && state.log.includes('createUser:new@b.com') && state.log.includes('rpc:service_register_user'), r.json?.error);
ok('OK create made no table call outside the minimum grants', !state.log.some(l => l.startsWith('dberror:')));
reset(); state.privileges = MINIMUM_GRANTS;
r = await asAdmin({ action: 'reset-password', userId: USER_ID, password: 'LongEnough123' });
ok('OK reset-password under the minimum grants -> 200 and change-on-login flagged', r.status === 200 && state.log.includes('rpc:service_flag_password_reset') && !state.log.some(l => l.startsWith('dberror:')), r.json?.error);
reset(); state.privileges = MINIMUM_GRANTS;
r = await asAdmin({ action: 'set-active', userId: USER_ID, active: false });
const deact = r.status === 200 && db.profiles.find(p => p.user_id === USER_ID).active === false && state.log.some(l => l.includes('876000h'));
r = await asAdmin({ action: 'set-active', userId: USER_ID, active: true });
ok('OK set-active false then true under the minimum grants -> 200 both ways, profile and ban updated', deact && r.status === 200 && db.profiles.find(p => p.user_id === USER_ID).active === true && !state.log.some(l => l.startsWith('dberror:')), r.json?.error);
reset(); state.privileges = MINIMUM_GRANTS;
r = await asAdmin({ action: 'update-email', userId: USER_ID, email: 'Fresh@B.com' });
ok('OK update-email under the minimum grants -> 200', r.status === 200 && r.json.email === 'fresh@b.com' && !state.log.some(l => l.startsWith('dberror:')));
reset(); state.privileges = MINIMUM_GRANTS;
const updates = []; await asAdmin({ action: 'set-active', userId: USER_ID, active: false }); state.log.filter(l => l.startsWith('update:')).forEach(l => updates.push(l));
ok('the only table UPDATE the function ever issues sets just {"active": ...}', updates.length === 1 && updates[0] === 'update:user_profiles:{"active":false}', updates.join(' | '));

// ---------------------------------------------------------------------------------------------------------------------
// COLUMN-level least privilege: the function must work with exactly the migration's columns, and every one is necessary.
// ---------------------------------------------------------------------------------------------------------------------
const flows = {
  create: () => { db.employees.push({ id: 4, active: true }); return asAdmin({ action: 'create', employeeId: 4, email: 'a@b.com', password: 'LongEnough123' }); },
  'reset-password': () => asAdmin({ action: 'reset-password', userId: USER_ID, password: 'LongEnough123' }),
  'set-active(false)': () => asAdmin({ action: 'set-active', userId: USER_ID, active: false }),
  'set-active(true)': () => { db.profiles.find(p => p.user_id === USER_ID).active = false; return asAdmin({ action: 'set-active', userId: USER_ID, active: true }); },
  'update-email': () => asAdmin({ action: 'update-email', userId: USER_ID, email: 'n@b.com' }),
};
const runFlows = async grants => {
  const res = {};
  for (const [name, flow] of Object.entries(flows)) { reset(); state.privileges = JSON.parse(JSON.stringify(grants)); const x = await flow(); res[name] = { status: x.status, perm: /permission denied/.test(x.json?.error || ''), denied: state.log.some(l => l.startsWith('dberror:')) }; }
  return res;
};
let res = await runFlows(MINIMUM_GRANTS);
ok('COLUMNS: all 5 admin flows (create, reset, activate, deactivate, email) succeed with EXACTLY the migration\'s column grants', Object.values(res).every(x => x.status === 200 && !x.denied), JSON.stringify(res));
let allNecessary = true; const necessity = [];
for (const [table, ops] of Object.entries(MINIMUM_GRANTS)) for (const [op, cols] of Object.entries(ops)) for (const col of cols) {
  const g = JSON.parse(JSON.stringify(MINIMUM_GRANTS)); g[table][op] = g[table][op].filter(c => c !== col);
  const broke = Object.entries(await runFlows(g)).filter(([, x]) => x.status === 500 && x.perm).map(([n]) => n);
  if (!broke.length) allNecessary = false; necessity.push(`${op}(${table}.${col}) -> ${broke.join('+') || 'NOTHING'}`);
}
ok('COLUMNS: removing ANY single granted column makes at least one flow fail with a permission error (none is superfluous)', allNecessary, necessity.join('; '));
res = await runFlows({ employees: { select: ['id', 'active'] }, user_profiles: { select: ['user_id', 'role'], update: ['active'] } });
ok('COLUMNS: without SELECT(user_profiles.employee_id) the existing-login check fails loudly (a WHERE column needs SELECT)', res.create.status === 500 && res.create.perm && res['set-active(false)'].status === 200, JSON.stringify(res.create));
ok('the function never mentions the sensitive columns at all (password_snapshot, must_change_password, created_at) and never uses select("*")', !/password_snapshot|must_change_password|created_at|select\(\s*['"]\*/.test(src.replace(/\/\/[^\n]*/g, '')));

console.log(out.join('\n')); console.log(`\n${pass} passed, ${fail} failed (mock supabase-js; NOT live Supabase)`);
process.exit(fail ? 1 : 0);
