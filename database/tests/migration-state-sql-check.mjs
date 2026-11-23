// LOCAL check (PGlite = real Postgres engine; NOT Supabase) of the migration-state SELECT in scripts/backup-lib.ps1
// ($script:MigrationStateSql). Setup: cd database/tests && npm i --no-save @electric-sql/pglite     Run: node migration-state-sql-check.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const repo = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const lib = readFileSync(repo + 'scripts/backup-lib.ps1', 'utf8');
const m = lib.match(/\$script:MigrationStateSql = @'\r?\n([\s\S]*?)\r?\n'@/);
if (!m) throw new Error('state SQL not found in backup-lib.ps1');
const stateSql = m[1];
const migration = readFileSync(repo + 'database/migrations/2026-11-23-two-role-user-management.sql', 'utf8');
const rollback = readFileSync(repo + 'database/migrations/2026-11-23-two-role-user-management.rollback.sql', 'utf8');
// The ORIGINAL production schema, pinned (commit ed23a6f). Do not use git HEAD: HEAD now contains the two-role setup SQL.
const oldSetup = readFileSync(repo + 'database/tests/fixtures/supabase_setup.pre-two-role.sql', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + String(d).slice(0, 260) : ''}`); };
const state = async db => (await db.query(stateSql)).rows[0];
const ORIGINAL = { new_columns: 0, role_check: false, unique_index: false, new_functions: 0, guard_trigger: false, role_function_updated: false, records_update_admin_only: false };
const APPLIED = { new_columns: 4, role_check: true, unique_index: true, new_functions: 5, guard_trigger: true, role_function_updated: true, records_update_admin_only: true };
const same = (a, b) => JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'string' ? Number(v) : v]))) === JSON.stringify(b);

const fresh = async () => {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, encrypted_password text, created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$; GRANT USAGE ON SCHEMA public, auth TO service_role;`);
  await db.exec(oldSetup);
  return db;
};

ok('the state query is one plain SELECT (the CLI rejects DO blocks under --read-only)', /^\s*select/i.test(stateSql) && !/\b(insert|update|delete|create|alter|drop|do)\b\s/i.test(stateSql.replace(/'[^']*'/g, '')));
const db = await fresh();
let r = await state(db);
ok('ORIGINAL production-like schema: every marker is absent', same(r, ORIGINAL), JSON.stringify(r));
await db.exec(migration);
r = await state(db);
ok('AFTER the migration: every marker is present', same(r, APPLIED), JSON.stringify(r));
await db.exec(rollback);
r = await state(db);
ok('AFTER the rollback: structural markers gone, only the 4 kept columns remain (a normal rolled-back database)', r.new_columns == 4 && !r.role_check && !r.unique_index && r.new_functions == 0 && !r.guard_trigger && !r.role_function_updated && !r.records_update_admin_only, JSON.stringify(r));
await db.exec(migration);
ok('RE-APPLIED after a rollback: every marker is present again', same(await state(db), APPLIED));

// partial states: knock out ONE structural marker at a time from a fully migrated database
const knockouts = {
  role_check: `ALTER TABLE public.user_profiles DROP CONSTRAINT chk_user_profile_role`,
  unique_index: `DROP INDEX public.uk_user_profiles_user_employee`,
  new_functions: `DROP FUNCTION public.admin_list_users()`,
  guard_trigger: `DROP TRIGGER trg_snack_record_user_guard ON public.snack_records`,
  role_function_updated: `CREATE OR REPLACE FUNCTION public.current_office_role() RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT profile.role FROM public.user_profiles AS profile WHERE profile.user_id = auth.uid() $$`,
  records_update_admin_only: `DROP POLICY office_records_update_guard ON public.snack_records; CREATE POLICY office_records_update_guard ON public.snack_records AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id())`,
};
for (const [marker, sql] of Object.entries(knockouts)) {
  const d = await fresh(); await d.exec(migration); await d.exec(sql);
  const row = await state(d);
  const flipped = Object.entries(APPLIED).filter(([k, v]) => String(row[k]) !== String(v) && Number(row[k]) !== v).map(([k]) => k);
  ok(`PARTIAL: with only "${marker}" undone, exactly that marker changes (everything else still present)`, flipped.length === 1 && flipped[0] === marker, `changed: ${flipped.join(',')}`);
}
console.log(`\n${pass} passed, ${fail} failed (LOCAL PGlite; NOT Supabase)`);
process.exit(fail ? 1 : 0);
