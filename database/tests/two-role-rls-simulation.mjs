// LOCAL SIMULATION (PGlite = real Postgres engine, mocked Supabase auth schema/roles).
// This is NOT a live Supabase test. Setup: cd database/tests && npm i --no-save @electric-sql/pglite
// Run from the REPO ROOT: node database/tests/two-role-rls-simulation.mjs   (needs git for the old setup file).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const repo = process.cwd();
// The ORIGINAL production schema, pinned (commit ed23a6f). Do not use git HEAD: HEAD now contains the two-role setup SQL.
const oldSetup = readFileSync(repo + '/database/tests/fixtures/supabase_setup.pre-two-role.sql', 'utf8');
const newSetup = readFileSync(`${repo}/database/supabase_setup.sql`, 'utf8');
const migration = readFileSync(`${repo}/database/migrations/2026-11-23-two-role-user-management.sql`, 'utf8');
const editMigration = readFileSync(`${repo}/database/migrations/2026-11-24-user-edit-own-snack-record.sql`, 'utf8');

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
await db.exec(editMigration);
ok('Re-running updated supabase_setup.sql then migrations keeps working', true);

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
const biscuitId = (await db.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Biscuit'`)).rows[0].id;
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
const beforeCount = (await db.query(`SELECT count(*)::int n FROM public.snack_records`)).rows[0].n;
const aUpd = await as(db, A, `UPDATE public.snack_records SET quantity=4, snack_id=${teaId}, unit_price=0, employee_id=${empB}, break_type='EVENING', taken_at='2020-01-01T00:00:00Z' WHERE id=${ownId}`);
ok('USER can UPDATE their own record', !aUpd.error && aUpd.affected === 1, aUpd.error || `${aUpd.affected} rows`);
const upd = (await db.query(`SELECT quantity,employee_id,break_type,unit_price,taken_at FROM public.snack_records WHERE id=${ownId}`)).rows[0];
ok('USER edit: quantity changed; employee, break, price, time are locked server-side', upd.quantity === 4 && String(upd.employee_id) === String(empA) && upd.break_type === 'MORNING' && Number(upd.unit_price) === 10 && new Date(upd.taken_at).getFullYear() >= 2026, JSON.stringify(upd));
const aSwap = await as(db, A, `UPDATE public.snack_records SET snack_id=${biscuitId} WHERE id=${ownId}`);
const swapped = (await db.query(`SELECT snack_id,unit_price FROM public.snack_records WHERE id=${ownId}`)).rows[0];
ok('USER snack change re-snapshots price server-side', !aSwap.error && String(swapped.snack_id) === String(biscuitId) && Number(swapped.unit_price) === 25, JSON.stringify(swapped));
const aInactiveUpd = await as(db, A, `UPDATE public.snack_records SET snack_id=${chipsId} WHERE id=${ownId}`);
ok('USER cannot switch a record to an inactive snack', !!aInactiveUpd.error, aInactiveUpd.error);
const aZero = await as(db, A, `UPDATE public.snack_records SET quantity=0 WHERE id=${ownId}`);
ok('USER cannot set quantity below 1', !!aZero.error, aZero.error);
ok('USER edits create no duplicate records', (await db.query(`SELECT count(*)::int n FROM public.snack_records`)).rows[0].n === beforeCount);
await db.exec(`UPDATE public.snack_records SET snack_id=${teaId}, unit_price=10, quantity=2 WHERE id=${ownId}`);
const aDel = await as(db, A, `DELETE FROM public.snack_records WHERE id=${ownId}`);
ok('USER cannot DELETE even their own record', (aDel.error || aDel.affected === 0) && true, aDel.error || `${aDel.affected} rows`);
const stillThere = (await db.query(`SELECT quantity FROM public.snack_records WHERE id=${ownId}`)).rows[0];
ok('Record intact after USER delete attempt', stillThere && stillThere.quantity === 2);
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

// ----- Path 4: rollback of 2026-11-24 (USER edits own record): UPDATE becomes ADMIN-only again, no data touched -----
const editRollback = readFileSync(`${repo}/database/migrations/2026-11-24-user-edit-own-snack-record.rollback.sql`, 'utf8');
const db4 = new PGlite();
await db4.exec(bootstrap); await db4.exec(newSetup); await db4.exec(migration); await db4.exec(editMigration);
const emp4 = (await db4.query(`SELECT id FROM public.employees WHERE name='Supabase Test Employee'`)).rows[0].id;
const tea4 = (await db4.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Tea'`)).rows[0].id;
await db4.exec(`INSERT INTO auth.users (id,email,encrypted_password) VALUES ('${ADMIN}','admin@x.test','h1'),('${A}','a@x.test','h2');
  INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}','admin',NULL),('${A}','user',${emp4});`);
const p4Ins = await as(db4, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type) VALUES (${emp4},${tea4},2,'MORNING') RETURNING id`);
const rec4 = p4Ins.rows?.[0]?.id;
const qty4 = async () => Number((await db4.query(`SELECT quantity FROM public.snack_records WHERE id=${rec4}`)).rows[0]?.quantity);
const p4Before = await as(db4, A, `UPDATE public.snack_records SET quantity=3 WHERE id=${rec4}`);
ok('Edit rollback baseline: USER A can update own record while the edit migration is applied', !p4Ins.error && !!rec4 && !p4Before.error && p4Before.affected === 1 && await qty4() === 3, p4Ins.error || p4Before.error || '');
const p4c0 = await counts(db4);
await db4.exec(editRollback);
const p4c1 = await counts(db4);
ok('Edit rollback: no employee/snack/record rows lost or added', JSON.stringify(p4c0) === JSON.stringify(p4c1) && p4c1.records >= 1, JSON.stringify(p4c1));
const p4Blocked = await as(db4, A, `UPDATE public.snack_records SET quantity=9 WHERE id=${rec4}`);
ok('Edit rollback: USER A can no longer update their own record (value unchanged)', (!!p4Blocked.error || p4Blocked.affected === 0) && await qty4() === 3, p4Blocked.error || `${p4Blocked.affected} rows`);
const p4Admin = await as(db4, ADMIN, `UPDATE public.snack_records SET quantity=5 WHERE id=${rec4}`);
ok('Edit rollback: ADMIN can still update records', !p4Admin.error && p4Admin.affected === 1 && await qty4() === 5, p4Admin.error || '');
await db4.exec(editMigration);
const p4Again = await as(db4, A, `UPDATE public.snack_records SET quantity=4 WHERE id=${rec4}`);
const p4c2 = await counts(db4);
ok('Edit migration re-applies after rollback: USER A can update own record again, data unchanged', !p4Again.error && p4Again.affected === 1 && await qty4() === 4 && JSON.stringify(p4c2) === JSON.stringify(p4c1), p4Again.error || '');

// ----- Path 5: explicit "No Snacks" days (2026-11-25): own-only, server-set date, conflict rules, rollback -----
const noSnacksMigration = readFileSync(`${repo}/database/migrations/2026-11-25-no-snacks-days.sql`, 'utf8');
const noSnacksRollback = readFileSync(`${repo}/database/migrations/2026-11-25-no-snacks-days.rollback.sql`, 'utf8');
const db5 = new PGlite();
await db5.exec(bootstrap); await db5.exec(newSetup); await db5.exec(migration); await db5.exec(editMigration);
const e5A = (await db5.query(`SELECT id FROM public.employees WHERE name='Supabase Test Employee'`)).rows[0].id;
const e5B = (await db5.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 02'`)).rows[0].id;
const tea5 = (await db5.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Tea'`)).rows[0].id;
await db5.exec(`INSERT INTO auth.users (id,email,encrypted_password) VALUES ('${ADMIN}','admin@x.test','h1'),('${A}','a@x.test','h2'),('${B}','b@x.test','h3');
  INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}','admin',NULL),('${A}','user',${e5A}),('${B}','user',${e5B});`);
await db5.exec(`DELETE FROM public.snack_records`); // the seed already has records dated today; start this scenario with a clean day (scratch DB only)
await db5.exec(noSnacksMigration);
await db5.exec(noSnacksMigration);
ok('No Snacks migration applies and is idempotent (second run succeeds)', true);
const n5Before = await counts(db5);
const kolkataToday = (await db5.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text d`)).rows[0].d;
const nsA = await as(db5, A, `INSERT INTO public.no_snack_days (employee_id, day) VALUES (${e5A}, '2020-01-01') RETURNING employee_id, day::text d`);
ok('USER A can submit No Snacks; employee is their own and the day is forced to today (client sent 2020)', !nsA.error && String(nsA.rows[0].employee_id) === String(e5A) && nsA.rows[0].d === kolkataToday, nsA.error || JSON.stringify(nsA.rows));
const n5After = await counts(db5);
ok('No Snacks creates no snack and no snack record (snacks / snack_records unchanged)', n5After.snacks === n5Before.snacks && n5After.records === n5Before.records, JSON.stringify(n5After));
const nsDup = await as(db5, A, `INSERT INTO public.no_snack_days (employee_id) VALUES (${e5A})`);
ok('Duplicate No Snacks for the same employee and day is rejected', !!nsDup.error && /uk_no_snack_employee_day/.test(nsDup.error), nsDup.error);
const nsThenSnack = await as(db5, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type) VALUES (${e5A},${tea5},1,'MORNING')`);
ok('After No Snacks, USER A cannot submit normal snacks for the same day', !!nsThenSnack.error && /No Snacks was already submitted/.test(nsThenSnack.error), nsThenSnack.error);
const bSnack = await as(db5, B, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type) VALUES (${e5B},${tea5},1,'MORNING')`);
const bThenNo = await as(db5, B, `INSERT INTO public.no_snack_days (employee_id) VALUES (${e5B})`);
ok('Another employee (B) can still submit snacks; after that B cannot submit No Snacks for the same day', !bSnack.error && !!bThenNo.error && /already recorded/.test(bThenNo.error), bSnack.error || bThenNo.error);
const aForB = await as(db5, A, `INSERT INTO public.no_snack_days (employee_id) VALUES (${e5B})`);
ok('USER cannot submit No Snacks on behalf of another employee', !!aForB.error, aForB.error);
await db5.exec(`DELETE FROM public.snack_records WHERE employee_id=${e5B}`);
await as(db5, B, `INSERT INTO public.no_snack_days (employee_id) VALUES (${e5B})`);
const aSees = await as(db5, A, `SELECT employee_id FROM public.no_snack_days`);
const adminSees = await as(db5, ADMIN, `SELECT employee_id FROM public.no_snack_days`);
ok('USER sees only their own No Snacks rows; ADMIN sees all', aSees.rows.length === 1 && String(aSees.rows[0].employee_id) === String(e5A) && adminSees.rows.length === 2, `${aSees.rows.length}/${adminSees.rows.length}`);
const aUpd5 = await as(db5, A, `UPDATE public.no_snack_days SET day='2020-01-01' WHERE employee_id=${e5A}`);
const aDel5 = await as(db5, A, `DELETE FROM public.no_snack_days WHERE employee_id=${e5A}`);
ok('USER cannot update or delete a No Snacks row', !!aUpd5.error && (!!aDel5.error || aDel5.affected === 0), `${aUpd5.error} | ${aDel5.error || aDel5.affected + ' rows'}`);
const anon5 = await as(db5, 'anon', `SELECT * FROM public.no_snack_days`);
ok('anon (not signed in) cannot read No Snacks rows', !!anon5.error, anon5.error);
const adminIns5 = await as(db5, ADMIN, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${e5A},${tea5},1,'MORNING',10) RETURNING id`);
const adminNo5 = await as(db5, ADMIN, `INSERT INTO public.no_snack_days (employee_id) VALUES (${e5B})`);
ok('ADMIN snack inserts are unaffected by No Snacks; ADMIN has no insert right on No Snacks', !adminIns5.error && !!adminNo5.error, adminIns5.error || adminNo5.error);
const adminDel5 = await as(db5, ADMIN, `DELETE FROM public.no_snack_days WHERE employee_id=${e5B}`);
ok('ADMIN can delete a No Snacks row', adminDel5.affected === 1, String(adminDel5.affected));
const n5c0 = await counts(db5);
await db5.exec(noSnacksRollback);
const n5c1 = await counts(db5);
const tableGone = (await db5.query(`SELECT to_regclass('public.no_snack_days') t`)).rows[0].t === null;
const aAfterRb = await as(db5, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type) VALUES (${e5A},${tea5},1,'EVENING')`);
ok('No Snacks rollback: table removed, employees/snacks/records unchanged, USER snack entry works again', tableGone && JSON.stringify(n5c0) === JSON.stringify(n5c1) && !aAfterRb.error, aAfterRb.error || JSON.stringify([n5c0, n5c1]));

// ----- Path 6: break-aware No Snacks (2026-11-26) applied on top of the 11-25 table, with a pre-existing day-level row -----
const breakMigration = readFileSync(`${repo}/database/migrations/2026-11-26-no-snacks-break-type.sql`, 'utf8');
const breakRollback = readFileSync(`${repo}/database/migrations/2026-11-26-no-snacks-break-type.rollback.sql`, 'utf8');
const db6 = new PGlite();
await db6.exec(bootstrap); await db6.exec(newSetup); await db6.exec(migration); await db6.exec(editMigration);
const e6A = (await db6.query(`SELECT id FROM public.employees WHERE name='Supabase Test Employee'`)).rows[0].id;
const e6B = (await db6.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 02'`)).rows[0].id;
const tea6 = (await db6.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Tea'`)).rows[0].id;
await db6.exec(`INSERT INTO auth.users (id,email,encrypted_password) VALUES ('${ADMIN}','admin@x.test','h1'),('${A}','a@x.test','h2'),('${B}','b@x.test','h3');
  INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}','admin',NULL),('${A}','user',${e6A}),('${B}','user',${e6B});
  DELETE FROM public.snack_records;`);
await db6.exec(noSnacksMigration);
await db6.exec(`INSERT INTO public.no_snack_days (employee_id) VALUES (${e6A})`); // a day-level row made before the break update
await db6.exec(`INSERT INTO public.no_snack_days (employee_id, day, created_at) VALUES (${e6B}, '2026-11-01', '2026-11-01T05:00:00Z')`); // an older legacy row
const legacyBefore = Number((await db6.query(`SELECT count(*)::int n FROM public.no_snack_days`)).rows[0].n);
await db6.exec(breakMigration);
await db6.exec(breakMigration);
const legacyRows = (await db6.query(`SELECT break_type FROM public.no_snack_days WHERE employee_id=${e6A} ORDER BY break_type`)).rows.map(r => r.break_type);
const legacyB = (await db6.query(`SELECT break_type, day::text d, created_at::text c FROM public.no_snack_days WHERE employee_id=${e6B} ORDER BY break_type`)).rows;
const legacyAfter = Number((await db6.query(`SELECT count(*)::int n FROM public.no_snack_days`)).rows[0].n);
ok('Break migration applies, is idempotent, and keeps an existing day-level row as MORNING + EVENING (nothing invented)', JSON.stringify(legacyRows) === JSON.stringify(['EVENING', 'MORNING']), JSON.stringify(legacyRows));
ok('Legacy rows are preserved: every old row (kept date and time) became exactly one Morning + one Evening row', legacyAfter === legacyBefore * 2 && legacyB.length === 2 && legacyB.every(r => r.d === '2026-11-01' && r.c.startsWith('2026-11-01 05:00')), JSON.stringify([legacyBefore, legacyAfter, legacyB]));
const policies = async () => JSON.stringify((await db6.query(`SELECT policyname FROM pg_policies WHERE tablename='no_snack_days' ORDER BY 1`)).rows.map(r => r.policyname));
const expectedPolicies = JSON.stringify(['office_no_snacks_delete', 'office_no_snacks_delete_guard', 'office_no_snacks_insert', 'office_no_snacks_insert_guard', 'office_no_snacks_select', 'office_no_snacks_select_guard']);
ok('Break migration leaves exactly the 11-25 RLS policies and the employee foreign key in place', await policies() === expectedPolicies && Number((await db6.query(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid='public.no_snack_days'::regclass AND contype='f'`)).rows[0].n) === 1, await policies());
await db6.exec(`DELETE FROM public.no_snack_days`);
const c6 = await counts(db6);
const ns = (who, emp, brk) => as(db6, who, `INSERT INTO public.no_snack_days (employee_id, break_type) VALUES (${emp}, ${brk === null ? 'NULL' : `'${brk}'`}) RETURNING break_type, day::text d`);
const bMorning = await ns(B, e6B, 'MORNING');
ok('Morning No Snacks is saved for the Morning break only (day forced to today)', !bMorning.error && bMorning.rows[0].break_type === 'MORNING' && bMorning.rows[0].d === kolkataToday, bMorning.error || '');
const bEvening = await ns(B, e6B, 'EVENING');
const bBoth = (await db6.query(`SELECT break_type FROM public.no_snack_days WHERE employee_id=${e6B} ORDER BY break_type`)).rows.map(r => r.break_type);
ok('Evening No Snacks is independent: Morning and Evening can both be submitted on the same date', !bEvening.error && JSON.stringify(bBoth) === JSON.stringify(['EVENING', 'MORNING']), bEvening.error || JSON.stringify(bBoth));
const dupM = await ns(B, e6B, 'MORNING'), dupE = await ns(B, e6B, 'EVENING');
ok('Duplicate No Snacks for the same employee, date AND break is rejected (both breaks)', /uk_no_snack_employee_day_break/.test(dupM.error || '') && /uk_no_snack_employee_day_break/.test(dupE.error || ''), `${dupM.error} | ${dupE.error}`);
const badBreak = await ns(B, e6B, 'NIGHT'), noBreak = await ns(A, e6A, null);
ok('A break is required and must be MORNING or EVENING', !!badBreak.error && !!noBreak.error, `${badBreak.error} | ${noBreak.error}`);
const snackIns = (who, emp, brk) => as(db6, who, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type) VALUES (${emp},${tea6},1,'${brk}') RETURNING id`);
const aMorningSnack = await snackIns(A, e6A, 'MORNING');
const aMorningNs = await ns(A, e6A, 'MORNING');
const aEveningNs = await ns(A, e6A, 'EVENING');
ok('Morning snack recorded -> Morning No Snacks refused, but Evening No Snacks is still allowed', !aMorningSnack.error && /already recorded for this break/.test(aMorningNs.error || '') && !aEveningNs.error, `${aMorningNs.error} | ${aEveningNs.error || 'evening ok'}`);
const aEveningSnack = await snackIns(A, e6A, 'EVENING');
const aMorningSnack2 = await as(db6, A, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type) VALUES (${e6A},${tea6},2,'MORNING')`);
ok('Evening No Snacks recorded -> Evening snacks refused; Morning snacks still work as before', /already submitted for this break/.test(aEveningSnack.error || '') && !aMorningSnack2.error, `${aEveningSnack.error} | ${aMorningSnack2.error || 'morning ok'}`);
const bEveSnack = await snackIns(B, e6B, 'EVENING');
ok('Morning+Evening No Snacks recorded -> snacks for either break are refused', /already submitted/.test(bEveSnack.error || '') && /already submitted/.test((await snackIns(B, e6B, 'MORNING')).error || ''), bEveSnack.error || '');
const c6b = await counts(db6);
ok('No Snacks creates no snack (snacks table unchanged); only the 2 normal snack records added', c6b.snacks === c6.snacks && c6b.records === c6.records + 2, JSON.stringify([c6, c6b]));
const aSees6 = await as(db6, A, `SELECT employee_id FROM public.no_snack_days`);
const forB = await ns(A, e6B, 'MORNING');
const aUpdDel6 = [await as(db6, A, `UPDATE public.no_snack_days SET break_type='MORNING' WHERE employee_id=${e6A}`), await as(db6, A, `DELETE FROM public.no_snack_days WHERE employee_id=${e6A}`)];
const adminNs6 = await ns(ADMIN, e6A, 'MORNING');
ok('RLS unchanged: USER sees only own rows, cannot add for others, cannot update/delete; ADMIN cannot add', aSees6.rows.every(r => String(r.employee_id) === String(e6A)) && aSees6.rows.length === 1 && !!forB.error && !!aUpdDel6[0].error && (!!aUpdDel6[1].error || aUpdDel6[1].affected === 0) && !!adminNs6.error, `${aSees6.rows.length} rows`);
const popSnap = async () => JSON.stringify((await db6.query(`SELECT id, employee_id, day::text d, break_type, created_at::text c FROM public.no_snack_days ORDER BY id`)).rows);
const popBefore = await popSnap();
await db6.exec(breakMigration);
ok('Re-running the break migration on a populated table changes no rows and keeps the policies', popBefore === await popSnap() && JSON.parse(popBefore).length >= 2 && await policies() === expectedPolicies, `${JSON.parse(popBefore).length} rows`);
const c6r0 = await counts(db6);
await db6.exec(breakRollback);
const afterRb = (await db6.query(`SELECT employee_id, count(*)::int n FROM public.no_snack_days GROUP BY employee_id ORDER BY employee_id`)).rows;
const colGone = (await db6.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='no_snack_days' AND column_name='break_type'`)).rows[0].n === 0;
const c6r1 = await counts(db6);
ok('Break rollback: column removed, one row per employee/day kept, employees/snacks/records unchanged', colGone && afterRb.every(r => r.n === 1) && JSON.stringify(c6r0) === JSON.stringify(c6r1), JSON.stringify(afterRb));
await db6.exec(breakMigration);
ok('Break migration re-applies cleanly after its rollback', (await db6.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='no_snack_days' AND column_name='break_type'`)).rows[0].n === 1);

// ----- Path 7: converting a No Snacks record into a normal snack (2026-11-27): atomic, own-row only, same break only -----
const editNsMigration = readFileSync(`${repo}/database/migrations/2026-11-27-no-snacks-edit.sql`, 'utf8');
const editNsRollback = readFileSync(`${repo}/database/migrations/2026-11-27-no-snacks-edit.rollback.sql`, 'utf8');
const db7 = new PGlite();
await db7.exec(bootstrap); await db7.exec(newSetup); await db7.exec(migration); await db7.exec(editMigration);
await db7.exec(noSnacksMigration); await db7.exec(breakMigration); await db7.exec(editNsMigration); await db7.exec(editNsMigration);
const e7A = (await db7.query(`SELECT id FROM public.employees WHERE name='Supabase Test Employee'`)).rows[0].id;
const e7B = (await db7.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 02'`)).rows[0].id;
const tea7 = (await db7.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Tea'`)).rows[0].id;
const bis7 = (await db7.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Biscuit'`)).rows[0].id;
const chips7 = (await db7.query(`SELECT id FROM public.snacks WHERE name='Supabase Sample Chips'`)).rows[0].id;
await db7.exec(`INSERT INTO auth.users (id,email,encrypted_password) VALUES ('${ADMIN}','admin@x.test','h1'),('${A}','a@x.test','h2'),('${B}','b@x.test','h3');
  INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}','admin',NULL),('${A}','user',${e7A}),('${B}','user',${e7B});
  UPDATE public.snacks SET unit_price = 10 WHERE id=${tea7}; UPDATE public.snacks SET unit_price = 25 WHERE id=${bis7}; UPDATE public.snacks SET active = FALSE WHERE id=${chips7};
  DELETE FROM public.snack_records;`);
ok('No Snacks edit migration applies and is idempotent (second run succeeds)', true);
const ns7 = (who, emp, brk) => as(db7, who, `INSERT INTO public.no_snack_days (employee_id, break_type) VALUES (${emp}, '${brk}') RETURNING id`);
const conv = (who, id, snack, qty) => as(db7, who, `SELECT public.convert_no_snacks_to_snack(${id}, ${snack}, ${qty}) AS id`);
const aM = (await ns7(A, e7A, 'MORNING')).rows[0].id, aE = (await ns7(A, e7A, 'EVENING')).rows[0].id;
const c7 = await counts(db7);
const cvM = await conv(A, aM, tea7, 3);
const recM = (await db7.query(`SELECT employee_id, snack_id, quantity, break_type, unit_price, (taken_at AT TIME ZONE 'Asia/Kolkata')::date::text d FROM public.snack_records WHERE id=${cvM.rows?.[0]?.id}`)).rows[0];
const leftNs = (await db7.query(`SELECT id, break_type FROM public.no_snack_days WHERE employee_id=${e7A} ORDER BY id`)).rows;
ok('Morning No Snacks -> normal snack: record has the right employee, snack, quantity, MORNING break, server price and today; the Morning No Snacks is gone and Evening is untouched',
  !cvM.error && recM && String(recM.employee_id) === String(e7A) && String(recM.snack_id) === String(tea7) && recM.quantity === 3 && recM.break_type === 'MORNING' && Number(recM.unit_price) === 10 && recM.d === kolkataToday && leftNs.length === 1 && String(leftNs[0].id) === String(aE) && leftNs[0].break_type === 'EVENING', cvM.error || JSON.stringify([recM, leftNs]));
const cvE = await conv(A, aE, bis7, 2);
const recE = (await db7.query(`SELECT snack_id, quantity, break_type, unit_price FROM public.snack_records WHERE id=${cvE.rows?.[0]?.id}`)).rows[0];
const recMAgain = (await db7.query(`SELECT quantity, snack_id FROM public.snack_records WHERE id=${cvM.rows[0].id}`)).rows[0];
ok('Evening No Snacks -> normal snack independently (different snack and price); the Morning record is unchanged', !cvE.error && recE.break_type === 'EVENING' && String(recE.snack_id) === String(bis7) && recE.quantity === 2 && Number(recE.unit_price) === 25 && recMAgain.quantity === 3 && String(recMAgain.snack_id) === String(tea7), cvE.error || '');
const bM = (await ns7(B, e7B, 'MORNING')).rows[0].id;
const cInactive = await conv(B, bM, chips7, 1), cZero = await conv(B, bM, tea7, 0);
const bStill = (await db7.query(`SELECT count(*)::int n FROM public.no_snack_days WHERE id=${bM}`)).rows[0].n;
const bRecs = (await db7.query(`SELECT count(*)::int n FROM public.snack_records WHERE employee_id=${e7B}`)).rows[0].n;
ok('Failed conversion (inactive snack / quantity 0) is rolled back: the No Snacks row stays and no snack record is created', /not available/.test(cInactive.error || '') && !!cZero.error && bStill === 1 && bRecs === 0, `${cInactive.error} | ${cZero.error} | ${bStill}/${bRecs}`);
await db7.exec(`INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${e7B},${tea7},1,'MORNING',10)`); // a conflicting snack for the same break
const cConflict = await conv(B, bM, tea7, 1);
const bStill2 = (await db7.query(`SELECT count(*)::int n FROM public.no_snack_days WHERE id=${bM}`)).rows[0].n;
const bRecs2 = (await db7.query(`SELECT count(*)::int n FROM public.snack_records WHERE employee_id=${e7B}`)).rows[0].n;
ok('Conflict: a snack already exists for that break -> conversion refused, nothing changed (No Snacks row kept, no duplicate record)', /already recorded for this break/.test(cConflict.error || '') && bStill2 === 1 && bRecs2 === 1, `${cConflict.error} | ${bStill2}/${bRecs2}`);
const bE = (await ns7(B, e7B, 'EVENING')).rows[0].id;
const cOther = await conv(A, bE, tea7, 1), cAdmin = await conv(ADMIN, bE, tea7, 1), cAnon = await conv('anon', bE, tea7, 1);
const bEStill = (await db7.query(`SELECT count(*)::int n FROM public.no_snack_days WHERE id=${bE}`)).rows[0].n;
ok("Only the owner can convert: another employee, ADMIN and anon are refused and B's Evening No Snacks is untouched", /could not be found/.test(cOther.error || '') && /Only an employee/.test(cAdmin.error || '') && !!cAnon.error && bEStill === 1, `${cOther.error} | ${cAdmin.error} | ${cAnon.error}`);
await db7.exec(`INSERT INTO public.no_snack_days (employee_id, day, break_type, created_at) VALUES (${e7A}, (now() AT TIME ZONE 'Asia/Kolkata')::date - 1, 'MORNING', now() - interval '1 day')`);
const oldId = (await db7.query(`SELECT id FROM public.no_snack_days WHERE employee_id=${e7A} AND day < (now() AT TIME ZONE 'Asia/Kolkata')::date`)).rows[0].id;
const cOld = await conv(A, oldId, tea7, 1);
ok("A past day's No Snacks cannot be converted (no back-dating); the row is kept", /Only today/.test(cOld.error || '') && (await db7.query(`SELECT count(*)::int n FROM public.no_snack_days WHERE id=${oldId}`)).rows[0].n === 1, cOld.error || '');
const reNs = await ns7(A, e7A, 'MORNING');
const cTwice = await conv(A, aM, tea7, 1);
ok('After conversion, a No Snacks for that break is refused again (snack exists) and the same record cannot be converted twice', /already recorded for this break/.test(reNs.error || '') && /could not be found/.test(cTwice.error || ''), `${reNs.error} | ${cTwice.error}`);
const c7b = await counts(db7);
const aRecCount = (await db7.query(`SELECT count(*)::int n FROM public.snack_records WHERE employee_id=${e7A}`)).rows[0].n;
ok('Conversions create no snack master data and exactly one record per converted No Snacks (no duplicates)', c7b.snacks === c7.snacks && aRecCount === 2 && c7b.records === c7.records + 3, JSON.stringify([c7, c7b]));
const c7r0 = await counts(db7);
await db7.exec(editNsRollback);
const fnGone = (await db7.query(`SELECT to_regprocedure('public.convert_no_snacks_to_snack(bigint,bigint,integer)') f`)).rows[0].f === null;
ok('No Snacks edit rollback removes only the function: employees/snacks/records unchanged, No Snacks rows kept', fnGone && JSON.stringify(c7r0) === JSON.stringify(await counts(db7)) && (await db7.query(`SELECT count(*)::int n FROM public.no_snack_days`)).rows[0].n >= 2);
await db7.exec(editNsMigration);
ok('No Snacks edit migration re-applies after its rollback', (await db7.query(`SELECT to_regprocedure('public.convert_no_snacks_to_snack(bigint,bigint,integer)') f`)).rows[0].f !== null);

// ----- Path 8: ADMIN edit / delete of No Snacks records (2026-11-28) -----
const adminEditMigration = readFileSync(`${repo}/database/migrations/2026-11-28-no-snacks-admin-edit.sql`, 'utf8');
const adminEditRollback = readFileSync(`${repo}/database/migrations/2026-11-28-no-snacks-admin-edit.rollback.sql`, 'utf8');
const db8 = new PGlite();
await db8.exec(bootstrap); await db8.exec(newSetup); await db8.exec(migration); await db8.exec(editMigration);
await db8.exec(noSnacksMigration); await db8.exec(breakMigration); await db8.exec(editNsMigration); await db8.exec(adminEditMigration); await db8.exec(adminEditMigration);
const e8A = (await db8.query(`SELECT id FROM public.employees WHERE name='Supabase Test Employee'`)).rows[0].id;
const e8B = (await db8.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 02'`)).rows[0].id;
const e8C = (await db8.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 03'`)).rows[0].id;
const tea8 = (await db8.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Tea'`)).rows[0].id;
await db8.exec(`INSERT INTO auth.users (id,email,encrypted_password) VALUES ('${ADMIN}','admin@x.test','h1'),('${A}','a@x.test','h2'),('${B}','b@x.test','h3');
  INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}','admin',NULL),('${A}','user',${e8A}),('${B}','user',${e8B});
  DELETE FROM public.snack_records;`);
ok('Admin edit migration applies and is idempotent (second run succeeds)', true);
const k8 = (await db8.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text d, ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text y, ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text t`)).rows[0];
const nsRow8 = async (who, emp, brk) => (await as(db8, who, `INSERT INTO public.no_snack_days (employee_id, break_type) VALUES (${emp}, '${brk}') RETURNING id`)).rows[0].id;
const aM8 = await nsRow8(A, e8A, 'MORNING'), bM8 = await nsRow8(B, e8B, 'MORNING'), bE8 = await nsRow8(B, e8B, 'EVENING');
const get8 = async id => (await db8.query(`SELECT employee_id, day::text d, break_type FROM public.no_snack_days WHERE id=${id}`)).rows[0];
const upd8 = (who, id, set) => as(db8, who, `UPDATE public.no_snack_days SET ${set} WHERE id=${id} RETURNING id`);
const n8c0 = await counts(db8);
const r1 = await upd8(ADMIN, aM8, `break_type='EVENING'`);
ok('ADMIN can change the break of another employee\'s No Snacks (Morning -> Evening)', !r1.error && r1.rows.length === 1 && (await get8(aM8)).break_type === 'EVENING', r1.error || '');
const r2 = await upd8(ADMIN, aM8, `day='${k8.y}', employee_id=${e8C}`);
const g2 = await get8(aM8);
ok('ADMIN can change the date and the employee', !r2.error && g2.d === k8.y && String(g2.employee_id) === String(e8C), r2.error || JSON.stringify(g2));
const dup8 = await upd8(ADMIN, bM8, `break_type='EVENING'`);
ok('Duplicate (same employee, date and break) is rejected and the row is unchanged', /uk_no_snack_employee_day_break/.test(dup8.error || '') && (await get8(bM8)).break_type === 'MORNING', dup8.error || '');
await db8.exec(`INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${e8C},${tea8},1,'MORNING',10)`);
const clash = await upd8(ADMIN, aM8, `day='${k8.d}', break_type='MORNING'`);
ok('Conflict with a normal snack for the same employee, date and break is rejected; the row is unchanged', /Snacks are already recorded/.test(clash.error || '') && (await get8(aM8)).d === k8.y, clash.error || '');
const otherBreak = await upd8(ADMIN, aM8, `day='${k8.d}', break_type='EVENING'`);
ok('...but the OTHER break of that employee/date is allowed (Morning/Evening stay independent)', !otherBreak.error && (await get8(aM8)).break_type === 'EVENING', otherBreak.error || '');
const future = await upd8(ADMIN, bM8, `day='${k8.t}'`), badBreak8 = await upd8(ADMIN, bM8, `break_type='NIGHT'`), badEmp = await upd8(ADMIN, bM8, `employee_id=999999`);
ok('Future date, invalid break and unknown employee are rejected', !!future.error && !!badBreak8.error && !!badEmp.error && (await get8(bM8)).d === k8.d, `${future.error} | ${badBreak8.error} | ${badEmp.error}`);
const uOwn = await upd8(A, aM8, `break_type='MORNING'`), uOther = await upd8(B, bM8, `break_type='MORNING', day='${k8.y}'`), uAnon = await upd8('anon', bM8, `day='${k8.y}'`);
const gB = await get8(bM8), gA = await get8(aM8);
ok('USER cannot edit No Snacks (own or anyone else\'s) and anon cannot; nothing changed', (!!uOwn.error || uOwn.rows.length === 0) && (!!uOther.error || uOther.rows.length === 0) && !!uAnon.error && gB.d === k8.d && gA.break_type === 'EVENING', `${uOwn.error || uOwn.rows.length} | ${uOther.error || uOther.rows.length}`);
const uCols = await as(db8, B, `UPDATE public.no_snack_days SET created_at = now() WHERE id=${bM8}`);
ok('Only employee/date/break columns are updatable (e.g. created_at is not)', !!uCols.error, uCols.error || '');
const uDel = await as(db8, B, `DELETE FROM public.no_snack_days WHERE id=${bM8}`);
ok('USER cannot delete No Snacks (rows kept)', (!!uDel.error || uDel.affected === 0) && !!(await get8(bM8)), uDel.error || `${uDel.affected} rows`);
const adminIns8 = await as(db8, ADMIN, `INSERT INTO public.no_snack_days (employee_id, break_type) VALUES (${e8A}, 'MORNING')`);
ok('ADMIN still cannot ADD No Snacks (employee-only submission is unchanged)', !!adminIns8.error, adminIns8.error);
const del8 = await as(db8, ADMIN, `DELETE FROM public.no_snack_days WHERE id=${bE8}`);
ok('ADMIN can delete exactly the selected No Snacks row; the others stay', del8.affected === 1 && !(await get8(bE8)) && !!(await get8(bM8)) && !!(await get8(aM8)), String(del8.affected));
const n8c1 = await counts(db8);
ok('Edits/deletes touch no employees, snacks or snack records', JSON.stringify(n8c0) === JSON.stringify({ ...n8c1, records: n8c1.records - 1 }), JSON.stringify([n8c0, n8c1]));
const uSub = await as(db8, B, `INSERT INTO public.no_snack_days (employee_id, break_type) VALUES (${e8B}, 'EVENING') RETURNING day::text d`);
ok('USER No Snacks submission still works (date forced to today)', !uSub.error && uSub.rows[0].d === k8.d, uSub.error || '');
await db8.exec(adminEditRollback);
const rbAdmin8 = await upd8(ADMIN, bM8, `break_type='MORNING'`);
ok('Admin edit rollback: edits are impossible again, data is intact', !!rbAdmin8.error && !!(await get8(bM8)) && !!(await get8(aM8)), rbAdmin8.error || '');
await db8.exec(adminEditMigration);
const reAdmin = await upd8(ADMIN, aM8, `day='${k8.y}'`);
ok('Admin edit migration re-applies after its rollback and edits work again', !reAdmin.error && reAdmin.rows.length === 1, reAdmin.error || '');

// ----- Path 9: ADMIN submits No Snacks for any employee (2026-11-29) -----
const adminSubmitMigration = readFileSync(`${repo}/database/migrations/2026-11-29-no-snacks-admin-submit.sql`, 'utf8');
const adminSubmitRollback = readFileSync(`${repo}/database/migrations/2026-11-29-no-snacks-admin-submit.rollback.sql`, 'utf8');
const db9 = new PGlite();
await db9.exec(bootstrap); await db9.exec(newSetup); await db9.exec(migration); await db9.exec(editMigration);
await db9.exec(noSnacksMigration); await db9.exec(breakMigration); await db9.exec(editNsMigration); await db9.exec(adminEditMigration);
await db9.exec(adminSubmitMigration); await db9.exec(adminSubmitMigration);
const e9A = (await db9.query(`SELECT id FROM public.employees WHERE name='Supabase Test Employee'`)).rows[0].id;
const e9B = (await db9.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 02'`)).rows[0].id;
const e9C = (await db9.query(`SELECT id FROM public.employees WHERE name='Supabase Sample Employee 03'`)).rows[0].id;
const tea9 = (await db9.query(`SELECT id FROM public.snacks WHERE name='Supabase Test Tea'`)).rows[0].id;
await db9.exec(`INSERT INTO auth.users (id,email,encrypted_password) VALUES ('${ADMIN}','admin@x.test','h1'),('${A}','a@x.test','h2'),('${B}','b@x.test','h3');
  INSERT INTO public.user_profiles (user_id, role, employee_id) VALUES ('${ADMIN}','admin',NULL),('${A}','user',${e9A}),('${B}','user',${e9B});
  DELETE FROM public.snack_records;`);
ok('Admin-submit migration applies and is idempotent (second run succeeds)', true);
const today9 = (await db9.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text d`)).rows[0].d;
const ns9 = (who, emp, brk) => as(db9, who, `INSERT INTO public.no_snack_days (employee_id, break_type) VALUES (${emp}, '${brk}') RETURNING employee_id, break_type, day::text d`);
const c9 = await counts(db9);
const adM9 = await ns9(ADMIN, e9A, 'MORNING'), adE9 = await ns9(ADMIN, e9A, 'EVENING'), adB9 = await ns9(ADMIN, e9B, 'MORNING');
ok('ADMIN can submit Morning and Evening No Snacks (independent) and for different employees; the day is forced to today',
  !adM9.error && !adE9.error && !adB9.error && adM9.rows[0].d === today9 && adE9.rows[0].break_type === 'EVENING' && String(adB9.rows[0].employee_id) === String(e9B), adM9.error || adE9.error || adB9.error || '');
const adDup9 = await ns9(ADMIN, e9A, 'MORNING');
ok('ADMIN duplicate (same employee, date, break) is rejected', /uk_no_snack_employee_day_break/.test(adDup9.error || ''), adDup9.error || '');
await db9.exec(`INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${e9C},${tea9},1,'EVENING',10)`);
const adClash9 = await ns9(ADMIN, e9C, 'EVENING'), adOther9 = await ns9(ADMIN, e9C, 'MORNING');
ok('ADMIN No Snacks is refused where snacks already exist for that employee/date/break, but the other break is allowed', /Snacks are already recorded for this break/.test(adClash9.error || '') && !adOther9.error, `${adClash9.error} | ${adOther9.error || 'morning ok'}`);
const adSnackBlocked9 = await as(db9, ADMIN, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${e9A},${tea9},1,'MORNING',10)`);
const adSnackFree9 = await as(db9, ADMIN, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${e9B},${tea9},2,'EVENING',10) RETURNING quantity, unit_price`);
ok('ADMIN snack entry is refused only for a break that already has No Snacks; otherwise it works exactly as before (quantity and price kept)',
  /No Snacks was already submitted/.test(adSnackBlocked9.error || '') && !adSnackFree9.error && adSnackFree9.rows[0].quantity === 2 && Number(adSnackFree9.rows[0].unit_price) === 10, `${adSnackBlocked9.error} | ${adSnackFree9.error || 'free ok'}`);
await db9.exec(`DELETE FROM public.no_snack_days WHERE employee_id=${e9A} AND break_type='MORNING'`); // free the slot so the USER path is really exercised
const aSelf9 = await ns9(A, e9A, 'MORNING');
ok('USER can still submit No Snacks for themselves (own employee, day forced to today)', !aSelf9.error && String(aSelf9.rows[0].employee_id) === String(e9A) && aSelf9.rows[0].d === today9, aSelf9.error || '');
const bSelf9 = await ns9(B, e9B, 'EVENING');
const aForB9 = await ns9(A, e9B, 'EVENING'), bForA9 = await ns9(B, e9A, 'MORNING');
ok('USER cannot submit No Snacks for another employee (RLS), either direction', !!aForB9.error && !!bForA9.error && /row-level security|already|uk_no_snack/.test(aForB9.error), `${aForB9.error} | ${bForA9.error}`);
await db9.exec(`DELETE FROM public.no_snack_days WHERE employee_id=${e9C}`);
const uClean9 = await ns9(A, e9C, 'MORNING');
ok('USER cannot submit for another employee even when there is no conflict (rule is RLS, not just duplicates)', /row-level security/.test(uClean9.error || ''), uClean9.error || '');
const anon9 = await as(db9, 'anon', `INSERT INTO public.no_snack_days (employee_id, break_type) VALUES (${e9A}, 'MORNING')`);
ok('anon cannot insert No Snacks', !!anon9.error, anon9.error);
await db9.exec(`UPDATE public.user_profiles SET active = FALSE WHERE user_id='${ADMIN}'`);
const inactiveAdmin9 = await ns9(ADMIN, e9C, 'MORNING');
await db9.exec(`UPDATE public.user_profiles SET active = TRUE WHERE user_id='${ADMIN}'`);
ok('An inactive admin cannot submit No Snacks', !!inactiveAdmin9.error, inactiveAdmin9.error);
const adEdit9 = await as(db9, ADMIN, `UPDATE public.no_snack_days SET day=(now() AT TIME ZONE 'Asia/Kolkata')::date - 1 WHERE employee_id=${e9B} AND break_type='MORNING' RETURNING id`);
const adDel9 = await as(db9, ADMIN, `DELETE FROM public.no_snack_days WHERE employee_id=${e9A} AND break_type='EVENING'`);
const adSees9 = await as(db9, ADMIN, `SELECT count(*)::int n FROM public.no_snack_days`);
ok('ADMIN can still view, edit and delete the No Snacks records (including ones admins created)', !adEdit9.error && adDel9.affected >= 1 && adSees9.rows[0].n >= 2, adEdit9.error || '');
const c9b = await counts(db9);
ok('No Snacks submissions create no snack master data (snacks unchanged; only the 2 snack records that were inserted)', c9b.snacks === c9.snacks && c9b.records === c9.records + 2, JSON.stringify([c9, c9b]));
const c9r0 = await counts(db9);
await db9.exec(adminSubmitRollback);
const rbIns9 = await ns9(ADMIN, e9C, 'EVENING');
const rbSnack9 = await as(db9, ADMIN, `INSERT INTO public.snack_records (employee_id,snack_id,quantity,break_type,unit_price) VALUES (${e9A},${tea9},1,'MORNING',10)`);
ok('Admin-submit rollback: admin No Snacks inserts are refused again, admin snack entry skips the guard again, data intact', !!rbIns9.error && !rbSnack9.error && JSON.stringify(c9r0) === JSON.stringify({ ...(await counts(db9)), records: (await counts(db9)).records - 1 }), `${rbIns9.error}`);
await db9.exec(adminSubmitMigration);
const reIns9 = await ns9(ADMIN, e9C, 'EVENING');
ok('Admin-submit migration re-applies after its rollback and admin submission works again', !reIns9.error || /uk_no_snack|already recorded/.test(reIns9.error), reIns9.error || 'ok');

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed (LOCAL PGlite simulation, not live Supabase)`);
process.exit(fail ? 1 : 0);
