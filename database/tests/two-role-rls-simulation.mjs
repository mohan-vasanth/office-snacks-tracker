// LOCAL SIMULATION (PGlite = real Postgres engine, mocked Supabase auth schema/roles).
// This is NOT a live Supabase test. Setup: cd database/tests && npm i --no-save @electric-sql/pglite
// Run from the REPO ROOT: node database/tests/two-role-rls-simulation.mjs   (needs git for the old setup file).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const repo = process.cwd();
const oldSetup = execSync('git show HEAD:database/supabase_setup.sql', { cwd: repo, encoding: 'utf8', maxBuffer: 1e7 });
const newSetup = readFileSync(`${repo}/database/supabase_setup.sql`, 'utf8');
const migration = readFileSync(`${repo}/database/migrations/2026-11-23-two-role-user-management.sql`, 'utf8');

const ADMIN = '00000000-0000-0000-0000-0000000000aa';
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';

const bootstrap = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, encrypted_password text, created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`;

let pass = 0, fail = 0;
const results = [];
const ok = (name, cond, detail = '') => { (cond ? pass++ : fail++); results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

async function as(db, who, sql, params = []) {
  // who: uuid of authenticated user, 'anon', 'service', or null (postgres)
  await db.exec('RESET ROLE');
  if (who === 'anon') await db.exec('SET ROLE anon');
  else if (who === 'service') await db.exec('SET ROLE service_role');
  else if (who) { await db.exec(`SELECT set_config('request.jwt.claim.sub','${who}',false)`); await db.exec('SET ROLE authenticated'); }
  try { const r = await db.query(sql, params); return { rows: r.rows, affected: r.affectedRows }; }
  catch (e) { return { error: e.message }; }
  finally { await db.exec('RESET ROLE'); await db.exec(`SELECT set_config('request.jwt.claim.sub','',false)`); }
}

async function seedLegacy(db) {
  await db.exec(`INSERT INTO auth.users (id,email,encrypted_password,created_at,last_sign_in_at) VALUES
    ('${ADMIN}','admin@x.test','hash-admin','2026-01-01','2026-11-20'),
    ('${A}','a@x.test','hash-a','2026-02-01',NULL),
    ('${B}','b@x.test','hash-b','2026-02-02',NULL),
    ('${C}','c@x.test','hash-c-temp','2026-11-23',NULL);`);
  await db.exec(`INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}','admin',NULL);`);
  await db.exec(`INSERT INTO public.user_profiles (user_id, role, employee_id)
    SELECT '${A}','employee', id FROM public.employees WHERE name='Supabase Test Employee';
    INSERT INTO public.user_profiles (user_id, role, employee_id)
    SELECT '${B}','employee', id FROM public.employees WHERE name='Supabase Sample Employee 02';`);
  await db.exec(`UPDATE public.snacks SET unit_price = 10 WHERE name='Supabase Test Tea';
    UPDATE public.snacks SET unit_price = 25 WHERE name='Supabase Test Biscuit';
    UPDATE public.snacks SET active = FALSE WHERE name='Supabase Sample Chips';
    INSERT INTO public.snack_records (employee_id, snack_id, quantity, break_type, unit_price, taken_at)
      SELECT e.id, s.id, 2, 'MORNING', 10, '2025-06-01T04:00:00Z' FROM public.employees e, public.snacks s WHERE e.name='Supabase Sample Employee 03' AND s.name='Supabase Test Tea';`);
}

async function counts(db) {
  const q = async t => Number((await db.query(`SELECT count(*)::int AS n FROM public.${t}`)).rows[0].n);
  return { employees: await q('employees'), snacks: await q('snacks'), records: await q('snack_records') };
}

// ===== Path 1: upgrade an existing install (old setup, legacy 'employee' roles) =====
const db = new PGlite();
await db.exec(bootstrap);
await db.exec(oldSetup);
await seedLegacy(db);
const before = await counts(db);
await db.exec(migration);
const after = await counts(db);
ok('Migration applies on an existing install', true);
ok('No employee/snack/record rows lost or added by migration', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
const roles = (await db.query(`SELECT role, count(*)::int n FROM public.user_profiles GROUP BY role ORDER BY role`)).rows;
ok("Legacy 'employee' profiles became 'user'; admin untouched", JSON.stringify(roles) === JSON.stringify([{ role: 'admin', n: 1 }, { role: 'user', n: 2 }]), JSON.stringify(roles));
const created = (await db.query(`SELECT created_at::date::text d FROM public.user_profiles WHERE user_id='${A}'`)).rows[0].d;
ok('Existing profile created_at backfilled from auth.users', created === '2026-02-01', created);

await db.exec(migration);
ok('Migration is idempotent (second run succeeds)', true);
await db.exec(newSetup);
await db.exec(migration);
ok('Re-running updated supabase_setup.sql then migration keeps working', true);

const roleOf = async u => (await as(db, u, 'SELECT public.current_office_role() r')).rows?.[0]?.r;
ok('current_office_role: admin -> admin', await roleOf(ADMIN) === 'admin');
ok('current_office_role: user A -> user', await roleOf(A) === 'user');
ok('current_office_role: anon -> error/denied', !!(await as(db, 'anon', 'SELECT public.current_office_role()')).error);

// ----- Admin -----
const adminEmp = await as(db, ADMIN, 'SELECT count(*)::int n FROM public.employees');
ok('ADMIN sees all employees', adminEmp.rows[0].n === before.employees, String(adminEmp.rows[0].n));
const adminRec = await as(db, ADMIN, 'SELECT count(*)::int n FROM public.snack_records');
ok('ADMIN sees all snack records', adminRec.rows[0].n === before.records);
const adminSnacks = await as(db, ADMIN, 'SELECT count(*)::int n FROM public.snacks');
ok('ADMIN sees active and inactive snacks', adminSnacks.rows[0].n === before.snacks);
const empB = (await db.query(`SELECT employee_id FROM public.user_profiles WHERE user_id='${B}'`)).rows[0].employee_id;
const empA = (await db.query(`SELECT employee_id FROM public.user_profiles WHERE user_id='${A}'`)).rows[0].employee_id;
const teaId = (await db.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Tea'`)).rows[0].id;
const chipsId = (await db.query(`SELECT id FROM public.snacks WHERE name='Supabase Sample Chips'`)).rows[0].id;
const adminIns = await as(db, ADMIN, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price,taken_at) VALUES (${empB},${teaId},1,'EVENING',7,'2025-01-01T00:00:00Z') RETURNING id,unit_price,taken_at`);
ok('ADMIN can insert a record for any employee (own price/timestamp kept)', !adminIns.error && Number(adminIns.rows[0].unit_price) === 7 && String(adminIns.rows[0].taken_at).includes('2025'), adminIns.error || '');
const adminRecId = adminIns.rows?.[0]?.id;
const adminUpd = await as(db, ADMIN, `UPDATE public.snack_records SET quantity=5 WHERE id=${adminRecId}`);
ok('ADMIN can update any record', adminUpd.affected === 1);
const adminDel = await as(db, ADMIN, `DELETE FROM public.snack_records WHERE id=${adminRecId}`);
ok('ADMIN can delete a record', adminDel.affected === 1);
const list = await as(db, ADMIN, 'SELECT * FROM public.admin_list_users()');
ok('ADMIN can call admin_list_users (with last sign-in)', !list.error && list.rows.length === 3 && list.rows.some(r => r.last_sign_in_at), list.error || `${list.rows?.length} rows`);

// ----- User A (own data only) -----
const aEmp = await as(db, A, 'SELECT id FROM public.employees');
ok('USER sees only their own employee row', aEmp.rows.length === 1 && String(aEmp.rows[0].id) === String(empA));
const aSnacks = await as(db, A, 'SELECT count(*)::int n FROM public.snacks WHERE NOT active');
ok('USER cannot see inactive snacks', aSnacks.rows[0].n === 0);
// seed a record for B and one for A (as postgres)
await db.exec(`INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${empB},${teaId},3,'MORNING',10)`);
await db.exec(`INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${empA},${teaId},1,'MORNING',10)`);
const aRec = await as(db, A, 'SELECT employee_id FROM public.snack_records');
ok("USER sees only own snack records (not B's, not legacy)", aRec.rows.length >= 1 && aRec.rows.every(r => String(r.employee_id) === String(empA)), `${aRec.rows.length} rows`);
const aProfiles = await as(db, A, 'SELECT user_id FROM public.user_profiles');
ok('USER can read only own profile row', aProfiles.rows.length === 1 && aProfiles.rows[0].user_id === A);
const aOwnIns = await as(db, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price,taken_at) VALUES (${empA},${teaId},2,'MORNING',0,'2020-01-01T00:00:00Z') RETURNING unit_price,taken_at`);
ok('USER can add own snack entry', !aOwnIns.error, aOwnIns.error || '');
ok('USER price is forced server-side (client sent 0, stored 10)', Number(aOwnIns.rows?.[0]?.unit_price) === 10, String(aOwnIns.rows?.[0]?.unit_price));
ok('USER timestamp is forced to now (client sent 2020)', new Date(aOwnIns.rows?.[0]?.taken_at).getFullYear() >= 2026, String(aOwnIns.rows?.[0]?.taken_at));
const aOtherIns = await as(db, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity) VALUES (${empB},${teaId},1)`);
ok("USER cannot insert a record for another employee", !!aOtherIns.error, aOtherIns.error);
const aInactiveSnack = await as(db, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity) VALUES (${empA},${chipsId},1)`);
ok('USER cannot record an inactive snack', !!aInactiveSnack.error, aInactiveSnack.error);
const ownId = (await db.query(`SELECT id FROM public.snack_records WHERE employee_id=${empA} ORDER BY id DESC LIMIT 1`)).rows[0].id;
const aUpd = await as(db, A, `UPDATE public.snack_records SET quantity=99 WHERE id=${ownId}`);
ok('USER cannot UPDATE even their own record', (aUpd.error || aUpd.affected === 0) && true, aUpd.error || `${aUpd.affected} rows`);
const aDel = await as(db, A, `DELETE FROM public.snack_records WHERE id=${ownId}`);
ok('USER cannot DELETE even their own record', (aDel.error || aDel.affected === 0) && true, aDel.error || `${aDel.affected} rows`);
const stillThere = (await db.query(`SELECT quantity FROM public.snack_records WHERE id=${ownId}`)).rows[0];
ok('Record unchanged after USER update/delete attempts', stillThere && stillThere.quantity === 2);
const aBRec = await as(db, A, `UPDATE public.snack_records SET quantity=0 WHERE employee_id=${empB}`);
ok("USER cannot modify another employee's records", (aBRec.error || aBRec.affected === 0));
const aEmpUpd = await as(db, A, `UPDATE public.employees SET name='x' WHERE id=${empA}`);
ok('USER cannot modify employee records', (aEmpUpd.error || aEmpUpd.affected === 0));
const aSnackIns = await as(db, A, `INSERT INTO public.snacks (name, unit_price) VALUES ('Hack', 0)`);
ok('USER cannot add snack master data', !!aSnackIns.error, aSnackIns.error);
const aSnackUpd = await as(db, A, `UPDATE public.snacks SET unit_price = 0 WHERE id=${teaId}`);
ok('USER cannot change snack prices', (aSnackUpd.error || aSnackUpd.affected === 0));
const aSnackDel = await as(db, A, `SELECT public.delete_snack_permanently(${teaId})`);
ok('USER cannot call delete_snack_permanently', !!aSnackDel.error, aSnackDel.error);
const aEmpDel = await as(db, A, `SELECT public.delete_employee_permanently(${empB})`);
ok('USER cannot call delete_employee_permanently', !!aEmpDel.error, aEmpDel.error);
const aEsc = await as(db, A, `UPDATE public.user_profiles SET role='admin', employee_id=NULL WHERE user_id='${A}'`);
ok('USER cannot escalate own role (no UPDATE privilege)', !!aEsc.error, aEsc.error);
const aIns = await as(db, A, `INSERT INTO public.user_profiles (user_id, role) VALUES ('${C}','admin')`);
ok('USER cannot insert profiles', !!aIns.error, aIns.error);
const aSnap = await as(db, A, 'SELECT password_snapshot FROM public.user_profiles');
ok('password_snapshot column is not readable by clients', !!aSnap.error, aSnap.error);
const aList = await as(db, A, 'SELECT * FROM public.admin_list_users()');
ok('USER cannot call admin_list_users', !!aList.error, aList.error);
const aSvc = await as(db, A, `SELECT public.service_register_user('${C}', ${empA})`);
ok('USER cannot call service_register_user', !!aSvc.error, aSvc.error);
const aSvc2 = await as(db, A, `SELECT public.service_flag_password_reset('${B}')`);
ok('USER cannot call service_flag_password_reset', !!aSvc2.error, aSvc2.error);
const adSvc = await as(db, ADMIN, `SELECT public.service_register_user('${C}', ${empA})`);
ok('ADMIN (browser) cannot call service-only helpers either', !!adSvc.error, adSvc.error);
const anonRead = await as(db, 'anon', 'SELECT * FROM public.snack_records');
ok('anon (not signed in) cannot read snack_records', !!anonRead.error, anonRead.error);
const anonList = await as(db, 'anon', 'SELECT * FROM public.admin_list_users()');
ok('anon cannot call admin_list_users', !!anonList.error);

// ----- Inactive user -----
await db.exec(`UPDATE public.user_profiles SET active = FALSE WHERE user_id='${A}'`);
ok('Inactive user: current_office_role is NULL', (await roleOf(A)) === null);
const iEmp = await as(db, A, 'SELECT * FROM public.employees');
const iRec = await as(db, A, 'SELECT * FROM public.snack_records');
const iSnk = await as(db, A, 'SELECT * FROM public.snacks');
ok('Inactive user reads 0 employees / 0 records / 0 snacks', iEmp.rows.length === 0 && iRec.rows.length === 0 && iSnk.rows.length === 0, `${iEmp.rows.length}/${iRec.rows.length}/${iSnk.rows.length}`);
const iIns = await as(db, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity) VALUES (${empA},${teaId},1)`);
ok('Inactive user cannot insert snack records', !!iIns.error, iIns.error);
const iOwn = await as(db, A, 'SELECT active FROM public.user_profiles');
ok('Inactive user can still read own profile flag (UI shows "deactivated")', iOwn.rows.length === 1 && iOwn.rows[0].active === false);
await db.exec(`UPDATE public.user_profiles SET active = TRUE WHERE user_id='${A}'`);
ok('Re-activated user regains access', (await roleOf(A)) === 'user');
// Other user unaffected
ok('Other USER (B) unaffected', (await roleOf(B)) === 'user');

// ----- New account: temp password + forced change + duplicate prevention -----
const empC = (await db.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 03'`)).rows[0].id;
const reg = await as(db, 'service', `SELECT public.service_register_user('${C}', ${empC})`);
ok('service_role can register a USER profile', !reg.error, reg.error || '');
const cProf = (await db.query(`SELECT role, active, must_change_password FROM public.user_profiles WHERE user_id='${C}'`)).rows[0];
ok("New account: role 'user', active, must_change_password = true", cProf.role === 'user' && cProf.active && cProf.must_change_password);
ok('New account has NO data access until password changed (role NULL)', (await roleOf(C)) === null);
const cData = await as(db, C, 'SELECT * FROM public.snack_records');
const cIns = await as(db, C, `INSERT INTO public.snack_records (employee_id,snack_id,quantity) VALUES (${empC},${teaId},1)`);
ok('New account cannot read or insert before changing password', cData.rows.length === 0 && !!cIns.error);
const early = await as(db, C, 'SELECT public.complete_password_change()');
ok('complete_password_change refuses while password is still the temporary one', !!early.error, early.error);
await db.exec(`UPDATE auth.users SET encrypted_password='hash-c-NEW' WHERE id='${C}'`); // what Auth does on updateUser
const done = await as(db, C, 'SELECT public.complete_password_change()');
ok('complete_password_change succeeds after the Auth hash changed', !done.error, done.error || '');
ok('After password change USER role/data access is granted', (await roleOf(C)) === 'user');
const cOwn = await as(db, C, 'SELECT employee_id FROM public.snack_records');
ok('After password change USER sees only records of their own employee', cOwn.rows.length > 0 && cOwn.rows.every(r => String(r.employee_id) === String(empC)), `${cOwn.rows.length} rows`);
const D = '00000000-0000-0000-0000-00000000000d';
await db.exec(`INSERT INTO auth.users (id,email,encrypted_password) VALUES ('${D}','d@x.test','hash-d')`);
const dup = await as(db, 'service', `SELECT public.service_register_user('${D}', ${empC})`);
ok('Second login for the same employee is rejected', !!dup.error && /uk_user_profiles_user_employee/.test(dup.error), dup.error);
await as(db, 'service', `SELECT public.service_flag_password_reset('${B}')`);
ok('Admin password reset forces change on next login (role NULL until changed)', (await roleOf(B)) === null);
const flagAdmin = await as(db, 'service', `SELECT public.service_flag_password_reset('${ADMIN}')`);
ok('Password-reset helper refuses ADMIN accounts', !!flagAdmin.error, flagAdmin.error);
const badRole = await db.query(`INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${D}','manager',${empC})`).then(() => null, e => e.message);
ok("Only two roles possible: 'manager' rejected by CHECK", /check constraint/.test(badRole || ''), badRole);
ok('Existing ADMIN still resolves to admin', (await roleOf(ADMIN)) === 'admin');

// ----- Path 2: fresh install with updated setup + migration -----
const db2 = new PGlite();
await db2.exec(bootstrap); await db2.exec(newSetup); await db2.exec(migration);
ok('Fresh install: updated setup + migration applies', true);

// ----- Path 3: rollback restores the previous behaviour without touching data -----
const rollback = readFileSync(`${repo}/database/migrations/2026-11-23-two-role-user-management.rollback.sql`, 'utf8');
const db3 = new PGlite();
await db3.exec(bootstrap); await db3.exec(oldSetup); await seedLegacy(db3);
const c0 = await counts(db3);
await db3.exec(migration); await db3.exec(rollback);
const c1 = await counts(db3);
ok('Rollback: no employee/snack/record rows lost', JSON.stringify(c0) === JSON.stringify(c1), JSON.stringify(c1));
const r3 = (await db3.query(`SELECT role, count(*)::int n FROM public.user_profiles GROUP BY role ORDER BY role`)).rows;
ok("Rollback: roles back to 'admin' / 'employee'", JSON.stringify(r3) === JSON.stringify([{ role: 'admin', n: 1 }, { role: 'employee', n: 2 }]), JSON.stringify(r3));
const rb = await as(db3, A, 'SELECT public.current_office_role() r');
ok("Rollback: legacy employee login resolves to 'employee'", rb.rows[0].r === 'employee');
const rbAdmin = await as(db3, ADMIN, 'SELECT count(*)::int n FROM public.snack_records');
ok('Rollback: ADMIN still reads all records', rbAdmin.rows[0].n === c1.records);
await db3.exec(migration);
ok('Migration re-applies cleanly after a rollback', true);

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed (LOCAL PGlite simulation, not live Supabase)`);
process.exit(fail ? 1 : 0);
