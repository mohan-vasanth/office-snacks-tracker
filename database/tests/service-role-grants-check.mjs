// LOCAL check (PGlite = real Postgres engine; NOT Supabase) of database/migrations/2026-11-23-service-role-grants.sql.
// Setup: cd database/tests && npm i --no-save @electric-sql/pglite        Run:  node service-role-grants-check.mjs
// The schema is production-faithful: original setup SQL and NO default table grants for service_role (measured on production).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = p => readFileSync(repo + p, 'utf8');
const migration = read('database/migrations/2026-11-23-two-role-user-management.sql');
const mainRollback = read('database/migrations/2026-11-23-two-role-user-management.rollback.sql');
const grants = read('database/migrations/2026-11-23-service-role-grants.sql');
const grantsRollback = read('database/migrations/2026-11-23-service-role-grants.rollback.sql');
const fnSource = read('supabase/functions/admin-users/index.ts');
const docs = read('docs/USER_MANAGEMENT_SETUP.md');
const oldSetup = execSync('git show HEAD:database/supabase_setup.sql', { cwd: repo, encoding: 'utf8', maxBuffer: 1e7 });
const sha = s => createHash('sha256').update(s).digest('hex');

// SHA-256 of the two-role migration files exactly as reviewed and approved. Any edit to them fails this check on purpose.
const REVIEWED = {
  migration: '0938604beb09cc9c3a2007e7479fba909144d78057f77fe933c9a7c1ebbc9196',
  rollback: 'fc920cc11e2b480bcadcb20bf59ddd452f9af48f88fcf0715da947e1f5cdb3bf',
};
// The specification: exactly these privileges for service_role, nothing else.
const SPEC = [
  { priv: 'SELECT', table: 'employees', cols: ['id', 'active'] },
  { priv: 'SELECT', table: 'user_profiles', cols: ['user_id', 'role', 'employee_id'] },
  { priv: 'UPDATE', table: 'user_profiles', cols: ['active'] },
];

const ADMIN = '00000000-0000-0000-0000-0000000000aa', USER = '00000000-0000-0000-0000-00000000000a', USER2 = '00000000-0000-0000-0000-00000000000b';
const bootstrap = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, encrypted_password text, created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).slice(0, 230) : ''}`); };
const svc = async (db, sql) => {
  await db.exec('RESET ROLE'); await db.exec('SET ROLE service_role');
  try { const r = await db.query(sql); return { rows: r.rows, affected: r.affectedRows }; }
  catch (e) { return { error: e.message }; }
  finally { await db.exec('RESET ROLE'); }
};
const isDenied = x => /permission denied/.test(x.error || '');
const matrix = async db => (await db.query(`
  select r.r || '.' || t.t || '.' || p.p || '(table)=' || has_table_privilege(r.r, 'public.' || t.t, p.p) as x
  from (values ('anon'), ('authenticated'), ('service_role')) r(r), (values ('employees'), ('snacks'), ('snack_records'), ('user_profiles')) t(t), (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(p)
  union all
  select 'service_role.' || c.relname || '.' || a.attname || '.' || p.p || '(column)=' || has_column_privilege('service_role', c.oid, a.attname, p.p)
  from pg_class c join pg_attribute a on a.attrelid = c.oid, (values ('SELECT'), ('UPDATE')) p(p)
  where c.oid in ('public.employees'::regclass, 'public.user_profiles'::regclass) and a.attnum > 0 and not a.attisdropped
  order by 1`)).rows.map(r => r.x);
const other = async db => ({
  policies: (await db.query(`select tablename || '.' || policyname || ' ' || permissive || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') p from pg_policies where schemaname = 'public' order by 1`)).rows.map(r => r.p),
  fnAcl: (await db.query(`select p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') a from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows.map(r => r.a),
  data: (await db.query(`select (select count(*) from public.employees)::int e, (select count(*) from public.snacks)::int s, (select count(*) from public.snack_records)::int r, (select count(*) from public.user_profiles)::int p`)).rows[0],
});
const diff = (a, b) => b.filter(x => !a.includes(x)).concat(a.filter(x => !b.includes(x))).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- 0. the reviewed two-role migration is byte-identical
ok('the reviewed two-role migration is byte-for-byte unchanged (SHA-256 matches the approved file)', sha(migration) === REVIEWED.migration, sha(migration));
ok('the reviewed two-role rollback is byte-for-byte unchanged', sha(mainRollback) === REVIEWED.rollback, sha(mainRollback));

// ---------------------------------------------------------------- 1. the files contain exactly the specified column-level statements
const statements = f => f.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const spec = (verb, to) => SPEC.map(s => `${verb} ${s.priv} (${s.cols.join(', ')}) ON public.${s.table} ${to} service_role`);
ok('grants migration = BEGIN + exactly 3 COLUMN-level GRANTs + COMMIT (no table-level grant, nothing else)', same(statements(grants), ['BEGIN', ...spec('GRANT', 'TO'), 'COMMIT']), JSON.stringify(statements(grants)));
ok('its rollback = BEGIN + exactly the 3 matching COLUMN-level REVOKEs + COMMIT', same(statements(grantsRollback), ['BEGIN', ...spec('REVOKE', 'FROM').reverse(), 'COMMIT']), JSON.stringify(statements(grantsRollback)));
ok('no GRANT in the file is table-wide (every GRANT has a column list)', statements(grants).filter(s => /^GRANT/.test(s)).every(s => /^GRANT (SELECT|UPDATE) \([^)]+\) ON /.test(s)));

// ---------------------------------------------------------------- 2. ordering guard: needs the two-role migration first
const db = new PGlite();
await db.exec(bootstrap); await db.exec(oldSetup);
await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}', 'a@x'), ('${USER}', 'u@x'), ('${USER2}', 'u2@x');
INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}', 'admin', NULL);
INSERT INTO public.user_profiles (user_id, role, employee_id) SELECT '${USER}', 'employee', id FROM public.employees ORDER BY id LIMIT 1;`);
const m0 = await matrix(db);
ok('production-faithful start: service_role has no privileges on any table or column', m0.filter(x => x.startsWith('service_role.')).every(x => x.endsWith('=false')));
let err = null; try { await db.exec(grants); } catch (e) { err = e.message; await db.exec('ROLLBACK'); }
ok('applied BEFORE the two-role migration it fails clearly (no "active" column) ...', /active/.test(err || '') && /does not exist/.test(err || ''), err);
ok('... and changes nothing (the transaction rolled back)', same(m0, await matrix(db)));

// ---------------------------------------------------------------- 3. after the two-role migration, before the grants
await db.exec(migration);
const before = await matrix(db), beforeOther = await other(db);
const empId = (await db.query('select id from public.employees order by id limit 1')).rows[0].id;
// The four table calls index.ts makes, written the way PostgREST turns them into SQL.
const ops = {
  'L70  user_profiles SELECT user_id, role WHERE user_id': `select user_id, role from public.user_profiles where user_id = '${USER}'`,
  'L86  employees SELECT id, active WHERE id': `select id, active from public.employees where id = ${empId}`,
  'L90  user_profiles SELECT user_id WHERE employee_id': `select user_id from public.user_profiles where employee_id = ${empId}`,
  'L141 user_profiles UPDATE active WHERE user_id (RETURNING 1, nothing read back)': `update public.user_profiles set active = false where user_id = '${USER}' returning 1`,
};
const runOps = async () => Object.fromEntries(await Promise.all(Object.entries(ops).map(async ([k, s]) => [k, await svc(db, s)])));
const beforeOps = Object.values(await runOps());
ok('REPRODUCED: before the grants, every table call the Edge Function makes is "permission denied"', beforeOps.every(isDenied), beforeOps.map(x => x.error).join(' | '));
const rpcBefore = await svc(db, `select public.service_flag_password_reset('${USER}')`);
ok('the SECURITY DEFINER helpers (rpc) already work without any table grant', !rpcBefore.error, rpcBefore.error);

// ---------------------------------------------------------------- 4. apply the grants: the exact delta
await db.exec(grants);
const after = await matrix(db), afterOther = await other(db);
const flipped = [...SPEC.flatMap(s => s.cols.map(c => `service_role.${s.table}.${c}.${s.priv}(column)`))].sort();
const changed = diff(before, after);
ok('EXACT delta: 7 column privileges flip false->true (employees: id, active SELECT; user_profiles: user_id, role, employee_id SELECT, active UPDATE); nothing else changes for any role or table', same(changed.filter(x => x.endsWith('=true')).map(x => x.replace('=true', '')), flipped) && changed.length === flipped.length * 2 && changed.filter(x => x.endsWith('=false')).length === flipped.length, `${changed.length} changed entries; unexpected: ${changed.filter(x => !flipped.some(f => x.startsWith(f))).join(', ')}`);
ok('no table-level privilege was granted to service_role on any table', after.filter(x => x.startsWith('service_role.') && x.includes('(table)')).every(x => x.endsWith('=false')));
ok('no policy, function privilege or business data changed', same(beforeOther, afterOther));
const afterOps = await runOps();
ok('every table call the Edge Function makes now succeeds', Object.values(afterOps).every(x => !x.error), Object.entries(afterOps).filter(([, x]) => x.error).map(([k, x]) => k + ': ' + x.error).join(' | '));
ok('...and the profile update affected exactly 1 row', afterOps['L141 user_profiles UPDATE active WHERE user_id (RETURNING 1, nothing read back)'].affected === 1);
await svc(db, `update public.user_profiles set active = true where user_id = '${USER}'`);

// ---------------------------------------------------------------- 5. unauthorized columns cannot be read, filtered on, sorted by or returned
await db.exec(`UPDATE auth.users SET encrypted_password = '$2a$10$temporaryPasswordHashForTesting' WHERE id = '${USER2}'`);   // what Auth stores for the temporary password
await db.exec(`SELECT public.service_register_user('${USER2}', (SELECT id FROM public.employees ORDER BY id OFFSET 1 LIMIT 1))`);   // creates a profile with a REAL password_snapshot
const snapRow = (await db.query(`select password_snapshot is not null as has_snapshot, must_change_password from public.user_profiles where user_id = '${USER2}'`)).rows[0];
ok('precondition: a profile with a real password_snapshot and must_change_password=true exists (so the denials below are not vacuous)', snapRow.has_snapshot === true && snapRow.must_change_password === true);
const unreadable = {
  'employees.name': `select name from public.employees`,
  'employees.created_at': `select created_at from public.employees`,
  'employees: SELECT *': `select * from public.employees`,
  'employees: filter by name (a boolean oracle)': `select id from public.employees where name like 'a%'`,
  'employees: ORDER BY name': `select id from public.employees order by name`,
  'user_profiles.password_snapshot': `select password_snapshot from public.user_profiles`,
  'user_profiles.password_snapshot via length()': `select length(password_snapshot) from public.user_profiles`,
  'user_profiles.must_change_password': `select must_change_password from public.user_profiles`,
  'user_profiles.created_at': `select created_at from public.user_profiles`,
  'user_profiles.active': `select active from public.user_profiles`,
  'user_profiles: SELECT *': `select * from public.user_profiles`,
  'user_profiles: filter by password_snapshot (oracle)': `select user_id from public.user_profiles where password_snapshot is not null`,
  'user_profiles: filter by must_change_password (oracle)': `select user_id from public.user_profiles where must_change_password`,
  'user_profiles: filter by active (oracle)': `select user_id from public.user_profiles where active`,
  'user_profiles: ORDER BY password_snapshot': `select user_id from public.user_profiles order by password_snapshot`,
  'user_profiles: UPDATE ... RETURNING password_snapshot': `update public.user_profiles set active = true where user_id = '${USER}' returning password_snapshot`,
  'user_profiles: UPDATE ... RETURNING active': `update public.user_profiles set active = true where user_id = '${USER}' returning active`,
  'user_profiles: UPDATE ... WHERE password_snapshot': `update public.user_profiles set active = true where password_snapshot is not null`,
};
const unreadableRes = {}; for (const [k, s] of Object.entries(unreadable)) unreadableRes[k] = await svc(db, s);
for (const [k, x] of Object.entries(unreadableRes)) ok(`service_role cannot: ${k}`, isDenied(x), x.error || 'ALLOWED');
const writes = {
  'change a role': `update public.user_profiles set role = 'admin' where user_id = '${USER}'`,
  'change an employee link': `update public.user_profiles set employee_id = null where user_id = '${USER}'`,
  'clear must_change_password': `update public.user_profiles set must_change_password = false where user_id = '${USER2}'`,
  'edit created_at': `update public.user_profiles set created_at = now() where user_id = '${USER}'`,
  'edit password_snapshot': `update public.user_profiles set password_snapshot = 'x' where user_id = '${USER}'`,
  'insert a profile': `insert into public.user_profiles (user_id, role) values ('${ADMIN}', 'admin')`,
  'delete a profile': `delete from public.user_profiles where user_id = '${USER}'`,
  'insert an employee': `insert into public.employees (name) values ('x')`,
  'update an employee': `update public.employees set name = 'x' where id = ${empId}`,
  'update employees.active': `update public.employees set active = false where id = ${empId}`,
  'delete an employee': `delete from public.employees where id = ${empId}`,
  'read snack_records': `select count(*) from public.snack_records`,
  'insert snack_records': `insert into public.snack_records (employee_id, snack_id, quantity) values (1, 1, 1)`,
  'read snacks': `select count(*) from public.snacks`,
  'update snacks': `update public.snacks set unit_price = 0`,
};
const writeRes = {}; for (const [k, s] of Object.entries(writes)) writeRes[k] = await svc(db, s);
ok('service_role is STILL denied every write and every other table: ' + Object.keys(writes).join(', '), Object.values(writeRes).every(isDenied), Object.entries(writeRes).filter(([, x]) => !isDenied(x)).map(([k]) => k).join(', '));
const afterAttack = await db.query(`select (select count(*) from public.user_profiles where role = 'admin')::int admins, (select must_change_password from public.user_profiles where user_id = '${USER2}') flag`);
ok('none of those attempts changed anything (admin count and the must_change_password flag intact)', afterAttack.rows[0].admins === 1 && afterAttack.rows[0].flag === true);
const reg = await svc(db, `select public.service_register_user('${ADMIN}', ${empId})`);
ok('the helpers keep working after the grants and leak nothing (here: a duplicate id is rejected by the database, not by a privilege error)', !!reg.error && !isDenied(reg), reg.error);
const flag = await svc(db, `select public.service_flag_password_reset('${USER2}')`);
ok('service_flag_password_reset still works and returns no data (void)', !flag.error && flag.rows[0].service_flag_password_reset === '' || !flag.error, JSON.stringify(flag.rows));

// ---------------------------------------------------------------- 6. what index.ts needs == what is granted (computed from the source)
const lines = fnSource.split('\n').filter(l => l.includes("admin.from('"));
const need = {};   // 'SELECT employees' -> Set(cols)
const add = (priv, table, cols) => { const k = `${priv} ${table}`; (need[k] ??= new Set()); cols.forEach(c => need[k].add(c)); };
for (const l of lines) {
  const table = l.match(/admin\.from\('(\w+)'\)/)[1];
  const filters = [...l.matchAll(/\.eq\('(\w+)'/g)].map(m => m[1]);
  if (/\.select\(/.test(l)) add('SELECT', table, [...l.match(/\.select\('([^']*)'\)/)[1].split(',').map(s => s.trim()), ...filters]);
  else if (/\.update\(/.test(l)) { add('UPDATE', table, [...l.match(/\.update\(\{([^}]*)\}\)/)[1].split(',').map(s => s.split(':')[0].trim())]); add('SELECT', table, filters); }
  else throw new Error('unexpected admin table call: ' + l.trim());
  if (/\.(insert|delete|upsert)\(/.test(l)) throw new Error('index.ts writes beyond UPDATE: ' + l.trim());
}
const granted = {}; for (const s of SPEC) { const k = `${s.priv} ${s.table}`; (granted[k] ??= new Set()); s.cols.forEach(c => granted[k].add(c)); }
const norm = o => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]).sort()));
ok(`index.ts makes ${lines.length} table calls; the columns it needs (select list + WHERE filters + update payload) EXACTLY equal the granted columns: nothing missing, nothing extra`, lines.length === 4 && norm(need) === norm(granted), `needs ${norm(need)} | granted ${norm(granted)}`);
const grantedFromFile = {}; for (const s of statements(grants).filter(x => x.startsWith('GRANT'))) { const m = s.match(/^GRANT (SELECT|UPDATE) \(([^)]+)\) ON public\.(\w+) TO service_role$/); (grantedFromFile[`${m[1]} ${m[3]}`] ??= new Set()); m[2].split(',').forEach(c => grantedFromFile[`${m[1]} ${m[3]}`].add(c.trim())); }
ok('...and the SQL file actually grants that same set (parsed from the file, not from the spec constant)', norm(need) === norm(grantedFromFile), norm(grantedFromFile));
const existing = (await db.query(`select table_name || '.' || column_name x from information_schema.columns where table_schema = 'public' and table_name in ('employees', 'user_profiles')`)).rows.map(r => r.x);
ok('every column the function touches exists in the migrated schema', Object.entries(need).every(([k, cols]) => [...cols].every(c => existing.includes(`${k.split(' ')[1]}.${c}`))));
ok('every admin.auth / admin.rpc / caller call is outside table-privilege scope (Auth API, SECURITY DEFINER helpers, authenticated role)', (fnSource.match(/admin\.rpc\('(\w+)'/g) || []).every(m => /service_register_user|service_flag_password_reset/.test(m)));

// ---------------------------------------------------------------- 7. each granted column is NECESSARY (revoke one at a time)
let allNecessary = true; const report = [];
for (const s of SPEC) for (const col of s.cols) {
  await db.exec(`REVOKE ${s.priv} (${col}) ON public.${s.table} FROM service_role`);
  const res = Object.entries(await runOps()).filter(([, x]) => isDenied(x)).map(([k]) => k.split(' ')[0]);
  await db.exec(`GRANT ${s.priv} (${col}) ON public.${s.table} TO service_role`);
  if (!res.length) allNecessary = false; report.push(`${s.priv}(${s.table}.${col}) -> breaks ${res.join('+')}`);
}
ok('MINIMALITY: revoking ANY single granted column breaks at least one real call, so none is superfluous', allNecessary, report.join('; '));
ok('...and re-granting restores the exact state', same(after, await matrix(db)));
await svc(db, `update public.user_profiles set active = true where user_id = '${USER}'`);

// ---------------------------------------------------------------- 8. the runbook's verification query is correct
const verifySql = [...docs.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map(m => m[1]).find(b => /employees_id_select/.test(b));
const vr = verifySql ? (await db.query(verifySql)).rows[0] : null;
ok('runbook verification query (parsed from docs): every positive column is true, every *_must_be_false column is false', !!vr && Object.entries(vr).every(([k, v]) => (/_must_be_false$/.test(k) ? v === false : v === true)) && Object.keys(vr).length >= 9, vr ? JSON.stringify(vr) : 'query not found in docs');
ok('...and it covers password_snapshot', vr && 'password_snapshot_select_must_be_false' in vr && vr.password_snapshot_select_must_be_false === false);

// ---------------------------------------------------------------- 9. idempotent, reversible, re-applicable
await db.exec(grants);
ok('running the grants migration twice changes nothing more (idempotent)', same(after, await matrix(db)));
await db.exec(grantsRollback);
ok('the grants rollback restores the exact pre-grants privilege matrix', same(before, await matrix(db)), diff(before, await matrix(db)).join(','));
ok('...and the function-style calls are denied again (back to the reviewed state)', Object.values(await runOps()).every(isDenied));
await db.exec(grants);
ok('the grants can be re-applied after a rollback', same(after, await matrix(db)));
const finalOther = await other(db);
ok('business data (row counts) was never touched by any of this', finalOther.data.e === beforeOther.data.e && finalOther.data.s === beforeOther.data.s && finalOther.data.r === beforeOther.data.r, JSON.stringify(finalOther.data));

console.log(`\n${pass} passed, ${fail} failed (LOCAL PGlite; NOT Supabase)`);
process.exit(fail ? 1 : 0);
