# Two-role user management: production runbook

Roles are exactly `admin` and `user` (ADMIN / USER). Project ref: `atmmjqwrqeidlqozuuje`.

**Status when this was written:** not applied to production. A read-only probe showed `admin_list_users` / `complete_password_change` do not exist and the `admin-users` Edge Function is not deployed. Nothing below has been run against your Supabase project by Claude.

## What the migration can and cannot touch

| Object | Effect |
|---|---|
| `employees`, `snacks`, `snack_records` rows | **Read only.** Not updated, deleted or recreated. |
| `user_profiles` rows | Role value `employee` becomes `user`; 4 new columns; `created_at` copied from Auth. These are the only data changes. |
| Policies, helper functions | The names the app already uses are replaced; new functions added. |
| Transaction | The whole file is one `BEGIN ... COMMIT`; any error rolls everything back. |

Compatibility: the previous frontend keeps working after the migration (it only reads `user_id, role, employee_id`, and non-admin roles are treated as a normal user). The new frontend also works **before** the migration (it falls back to the old columns), so the order of frontend and database rollout is not critical. Apply the migration first anyway.

## Guided deployment (Windows PowerShell)

`scripts\deploy-two-role.ps1` runs these steps one stage at a time, each gated by a confirmation, always with the explicit project ref, never printing tokens or keys. Do not use `npm i -g supabase` (not supported); the script uses `npx`.
```
npx supabase login                                   # once; opens a browser
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-two-role.ps1 -Stage check    # read-only: CLI, login, link, pre-flight
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-two-role.ps1 -Stage backup   # READ-ONLY verified local backup (creates nothing in production)
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-two-role.ps1 -Stage migrate  # re-verifies the backup, type APPLY; verifies row counts identical
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-two-role.ps1 -Stage deploy   # Edge Function
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-two-role.ps1 -Stage verify   # read-only probes
```
Never run `supabase db reset` or `supabase db push` for this project: `reset` destroys data, and `push` expects a `supabase/migrations` history that this repo does not use. The manual route is below.

## 0. Backup (before anything else): verified, local, read-only

`-Stage backup` creates **no** table or other object in production. It reads the four tables the app uses and writes them to `backups\<UTC timestamp>-<ref>\` on your computer. (An earlier draft created a `user_profiles_backup_...` snapshot table. That was removed: a local backup covers the same rows without adding anything to your production schema, and `create table if not exists` could silently keep a stale copy.)

What it does and checks, in order:

1. Refuses to start unless `backups/` is git-ignored and nothing under it is tracked.
2. Counts each table, exports it in key order, 500 rows per page (no single huge response), counts again. The exported total must equal the database count **before and after**; if rows were added or removed during the export, or a page is short, it stops.
3. Writes `employees.json`, `snacks.json`, `snack_records.json`, `user_profiles.json` (each: `meta` + `rows`) and `schema-reference.json` (policies and helper functions, for reference).
4. Re-reads every file from disk and parses it. It checks the project ref in the file, the header row count against the number of rows actually present, the count against the database, that every row has its key, and that no key is duplicated.
5. Records SHA-256 and byte size of every file, plus timestamp, project ref and the before/after database counts, in `manifest.json`, which is written **last**. The folder is renamed from `...-INCOMPLETE` to its final name only after all of that passes. A failed run leaves an `-INCOMPLETE` folder that nothing will ever accept.
6. Re-verifies the finished folder against the live counts and prints a summary table.

Every run gets a new folder; nothing is overwritten or reused. Any failure throws and the deployment stops.

`-Stage migrate` never trusts "a backup exists". It re-verifies the newest folder from disk (manifest, project, SHA-256, full re-parse), requires it to be at most 6 hours old (`-MaxBackupAgeHours`), and requires the live row counts to still equal the backup. If anything changed since the backup it stops and asks for a fresh one. If the app is in use, do the backup and migration back to back.

The backup files contain real employee names and consumption records. Keep the folder private.

Optional extras (not required by the script): Dashboard → Database → Backups on Pro plans, or `pg_dump "postgresql://postgres.<ref>:<DB_PASSWORD>@<pooler-host>:5432/postgres" --schema=public -Fc -f before-two-role.dump` (`supabase db dump --linked` needs Docker).

Three Supabase CLI / Windows behaviours the scripts deliberately work around (all were hit in real runs):

- **SQL is passed with `--file`, never as an argument.** On Windows `npx` is a `.cmd` shim and `cmd.exe` cuts a command line at the first newline, so multi-line SQL reached Postgres truncated (`syntax error at end of input`). The schema-reference query was the first multi-line query and failed this way; the single-line table exports were unaffected.
- **`npx` from PowerShell is `npx.ps1`, which re-runs the source text of the calling statement.** Called as `& npx ... @args` inside a function, the arguments are duplicated and the CLI prints its general help **and exits 0** without doing anything (this is what happened on the first `-Stage migrate`: nothing was applied). The script calls `npx.cmd`, and `-Stage migrate` never trusts an exit code: it checks seven markers in the database before and after (not applied / applied / partial) and refuses to run over an applied or partial database.
- **`--read-only` refuses `DO` blocks** (`only allows SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN`). The pre-flight and post-migration checks are therefore plain `SELECT` statements whose columns are true/false verdicts, evaluated by the script.

## Recovering the original data

Use this only if data or profiles are damaged. The migration never modifies employees, snacks or snack_records, so the usual need is the profile roles.

1. **Stop and assess.** Do not delete anything. Note which table is wrong (the post-migration check prints row counts).
2. **Generate restore SQL from a verified backup** (it re-verifies the backup first, connects to nothing and runs nothing):
   ```
   powershell -ExecutionPolicy Bypass -File .\scripts\restore-from-backup.ps1 -BackupDir .\backups\<folder>
   ```
   It writes `backups\<folder>\restore-sql\01-employees.sql`, `02-snacks.sql`, `03-snack_records.sql` and `04-user_profiles.sql`. Open and read them.
3. **Profiles only wrong (most likely case):** run `database/migrations/2026-11-23-two-role-user-management.rollback.sql` (restores the `employee` role names and old policies, touches no business data), then run `04-user_profiles.sql`. The profile restore refuses to run while the new role constraint exists, so it cannot be applied to the migrated schema by mistake.
4. **Rows missing from employees / snacks / snack_records:** run `01`, `02`, `03` in that order (foreign keys). They `INSERT ... ON CONFLICT (id) DO NOTHING` with the original ids and advance the id sequences. Rows that still exist are never updated or deleted, and running a file twice is harmless.
5. Run each file with `npx supabase db query --remote=atmmjqwrqeidlqozuuje --file <file>` (it asks for confirmation) or paste it into the SQL Editor. `03-snack_records.sql` may be too large to paste; use the CLI.
6. **Verify:** row counts match `manifest.json` (and the numbers the backup printed), the admin can sign in, History and Reports open.
7. Whole-database loss is a Supabase-level restore (Dashboard backups or a `pg_dump` restore), not something these scripts do.

Every step above, including restoring into completely emptied tables, was exercised on a local Postgres (see "Automated tests"). It has not been run against your Supabase project.

## 1. Validate (read-only, SQL Editor)

```sql
-- must show your admin; role values must only be 'admin' / 'employee'
select user_id, role, employee_id from public.user_profiles;
-- the migration refuses to run if this returns rows (two logins for one employee)
select employee_id, count(*) from public.user_profiles where employee_id is not null group by 1 having count(*) > 1;
-- existing policies; expect the office_* names from supabase_setup.sql
select tablename, policyname, permissive, cmd from pg_policies where schemaname = 'public' order by 1, 2;
-- row counts to compare after the migration
select (select count(*) from public.employees) e, (select count(*) from public.snacks) s, (select count(*) from public.snack_records) r;
```
If you see policies that are **not** named `office_*` (added by hand), check them: a permissive policy such as `USING (true)` for `authenticated` is neutralised by the restrictive `office_*_guard` policies, but review anything unexpected before continuing.

## 2. Apply the migration

SQL Editor → New query → paste `database/migrations/2026-11-23-two-role-user-management.sql` → Run. Expect "Success. No rows returned." Re-running is safe.

Verify:
```sql
select role, count(*) from public.user_profiles group by 1;                 -- admin n, user m (no 'employee')
select public.current_office_role();                                        -- (run as postgres: null is normal)
select e, s, r from (select (select count(*) from public.employees) e, (select count(*) from public.snacks) s, (select count(*) from public.snack_records) r) t;  -- same as step 1
select policyname, cmd from pg_policies where tablename = 'snack_records' and permissive = 'RESTRICTIVE' order by 1;
```
If your admin row is missing, run `database/link_supabase_admin.sql`.

### Rollback (only if needed)
Run `database/migrations/2026-11-23-two-role-user-management.rollback.sql`. It restores the old roles/policies, touches no employee/snack/record rows, and keeps the new columns. Note it also stops enforcing `active`.

## 2b. Service-role grants (required before the Edge Function can work)

On this project `service_role` holds **no** `SELECT/INSERT/UPDATE/DELETE` on the app tables (`BYPASSRLS` skips policies, not GRANTs). The `admin-users` function makes four table calls with that role, so without grants every call fails with `permission denied`. The function reports that as an error that names this file; it no longer answers "Employee not found" / "User account not found".

**What the function needs, taken from `index.ts`** (a column used only in a `WHERE` clause still needs `SELECT`):

| Call | Table | Needs |
|---|---|---|
| look up the account to manage | `user_profiles` | SELECT `user_id`, `role` (WHERE `user_id`) |
| look up the employee to link | `employees` | SELECT `id`, `active` (WHERE `id`) |
| reject a second login for one employee | `user_profiles` | SELECT `user_id`, and `employee_id` for the WHERE |
| activate / deactivate | `user_profiles` | UPDATE `active` (WHERE `user_id`; nothing is read back) |

Auth calls use the Auth API, and account creation / password reset use `SECURITY DEFINER` helper functions (EXECUTE only), so none of them need table privileges.

`database/migrations/2026-11-23-service-role-grants.sql` is a separate file (the reviewed two-role migration is unchanged) and contains exactly three **column-level** grants:

```sql
BEGIN;
GRANT SELECT (id, active) ON public.employees TO service_role;
GRANT SELECT (user_id, role, employee_id) ON public.user_profiles TO service_role;
GRANT UPDATE (active) ON public.user_profiles TO service_role;
COMMIT;
```

- Apply it **after** the two-role migration (the `UPDATE` grant names the new `active` column; applied too early it fails and changes nothing).
- `service_role` **cannot** read `user_profiles.password_snapshot` (a bcrypt hash of an admin-set temporary password), `must_change_password`, `created_at` or `active`, nor `employees.name` / `created_at`. That also closes the side channels: `SELECT *`, `WHERE`, `ORDER BY` and `RETURNING` on those columns are all denied.
- It still cannot change roles or employee links, cannot write `employees`, and cannot touch `snack_records` or `snacks`.
- Safe to run twice. Undo with `2026-11-23-service-role-grants.rollback.sql` (revokes exactly those three, touches no data).

Apply (asks for the CLI's own confirmation):
```
npx supabase db query --remote=atmmjqwrqeidlqozuuje --file database\migrations\2026-11-23-service-role-grants.sql
```
Verify (read-only; a plain SELECT, so it also works with `--read-only`): every column not ending in `_must_be_false` must be `true`, the rest `false`.
```sql
select
  has_column_privilege('service_role', 'public.employees', 'id', 'SELECT')                       as employees_id_select,
  has_column_privilege('service_role', 'public.employees', 'active', 'SELECT')                   as employees_active_select,
  has_column_privilege('service_role', 'public.user_profiles', 'user_id', 'SELECT')              as profiles_user_id_select,
  has_column_privilege('service_role', 'public.user_profiles', 'role', 'SELECT')                 as profiles_role_select,
  has_column_privilege('service_role', 'public.user_profiles', 'employee_id', 'SELECT')          as profiles_employee_id_select,
  has_column_privilege('service_role', 'public.user_profiles', 'active', 'UPDATE')               as profiles_active_update,
  has_column_privilege('service_role', 'public.user_profiles', 'password_snapshot', 'SELECT')    as password_snapshot_select_must_be_false,
  has_column_privilege('service_role', 'public.user_profiles', 'must_change_password', 'SELECT') as must_change_password_select_must_be_false,
  has_column_privilege('service_role', 'public.user_profiles', 'role', 'UPDATE')                 as role_update_must_be_false,
  has_column_privilege('service_role', 'public.employees', 'name', 'SELECT')                     as employee_name_select_must_be_false,
  has_table_privilege('service_role', 'public.snack_records', 'SELECT')                          as snack_records_select_must_be_false;
```

### Deployment order (each step needs your explicit approval; nothing here has been run against production)
1. `-Stage backup` (done: `backups\20261123T092143Z-atmmjqwrqeidlqozuuje`; repeat if live counts changed or it is older than 6 h).
2. `-Stage migrate`: the two-role migration (`2026-11-23-two-role-user-management.sql`).
3. Service-role grants (this section) and the verification query above.
4. `-Stage deploy`: the Edge Function (already contains the error-handling fix).
5. `-Stage verify`, then the manual checklist in section 4.

If step 3 is skipped, step 4's function deploys fine but creating or managing users fails with a `permission denied ... apply database/migrations/2026-11-23-service-role-grants.sql` message.

## 3. Deploy the Edge Function

Secrets: Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` into every Edge Function automatically. **Do not create them yourself and never put the service-role key in `frontend/` or any `VITE_` variable.** `npx supabase secrets list --project-ref atmmjqwrqeidlqozuuje` should show nothing you need to add.

```
npx supabase login
npx supabase link --project-ref atmmjqwrqeidlqozuuje
npx supabase functions deploy admin-users --no-verify-jwt --use-api --project-ref atmmjqwrqeidlqozuuje
npx supabase functions list --project-ref atmmjqwrqeidlqozuuje
```
Run from the repository root. `--no-verify-jwt` is safe here because `index.ts` verifies the caller itself before doing anything: it requires a Bearer token, validates it with Supabase Auth (`auth.getUser(token)`), then asks the database for the caller's role (`current_office_role()`, which is NULL for inactive or must-change accounts) and rejects anything but `admin`. Role claims in the request body are ignored.

Dashboard route: Edge Functions → Deploy a new function → Via Editor → name `admin-users` → paste `supabase/functions/admin-users/index.ts` → Deploy → in the function's settings turn **Verify JWT** off.

Check it is live and refuses strangers (should print 401 and `Sign in required.`):
```
curl -s -i -X POST https://atmmjqwrqeidlqozuuje.supabase.co/functions/v1/admin-users -H "Content-Type: application/json" -d "{}"
```

## 4. Production verification (do these yourself and tick them off)

Use a throwaway employee and a private window for the USER.

| # | Step | Expected |
|---|------|----------|
| 1 | Sign in as the existing admin | Works; ADMIN badge; 8 menu items incl. User Management |
| 2 | Compare the row counts from step 1/2 | Identical |
| 3 | Employees / Snacks: add, edit, deactivate, delete a throwaway item | Works as before |
| 4 | Snack History + Reports: Download PDF, CSV, WhatsApp text | Works as before |
| 5 | User Management → create user for the throwaway employee | Credentials dialog shows temp password once |
| 6 | Try to create another login for the same employee | Not offered / rejected |
| 7 | USER window: sign in with the temp password | "Set a new password" screen, no app yet |
| 8 | Set a new password | App opens; USER badge; Dashboard, Take Snacks, Snack History only |
| 9 | USER records a snack | Saved for their own employee |
| 10 | USER Snack History | Only own records; no Edit/Delete/Export |
| 11 | Run the direct API checks below as the USER | All denied as noted |
| 12 | Admin: Edit email, Reset password, Deactivate | Each shows success; reset forces a new password change |
| 13 | USER window after deactivation | Signed out within ~30 s; sign-in refused |
| 14 | Admin: Activate | USER can sign in again |
| 15 | Sign out, reload | Login screen |

**Direct API checks as the USER.** In the USER's browser, with the app open, run in DevTools console (replace `<URL>`, `<KEY>`, `<TOKEN>` with the project URL, the publishable key from `.env.local`, and the `access_token` from Application → Local Storage → `sb-...-auth-token`):
```js
const h = { apikey: '<KEY>', Authorization: 'Bearer <TOKEN>', 'Content-Type': 'application/json', Prefer: 'return=representation' };
const get = p => fetch('<URL>/rest/v1/' + p, { headers: h }).then(async r => [r.status, await r.text()]);
await get('snack_records?select=employee_id');          // only your employee_id
await get('employees?select=id');                         // only your row
await get('user_profiles?select=password_snapshot');      // 401/403 column denied
await fetch('<URL>/rest/v1/snack_records?id=gt.0', { method: 'DELETE', headers: h }).then(r => r.text()); // [] nothing deleted
await fetch('<URL>/rest/v1/snacks', { method: 'POST', headers: h, body: JSON.stringify({ name: 'x' }) }).then(r => r.status); // 401/403
await fetch('<URL>/rest/v1/rpc/admin_list_users', { method: 'POST', headers: h, body: '{}' }).then(r => r.status); // 403/401
await fetch('<URL>/functions/v1/admin-users', { method: 'POST', headers: h, body: JSON.stringify({ action: 'set-active', userId: '<any uuid>', active: false }) }).then(async r => [r.status, await r.text()]); // 403 Admin access required.
```

## Troubleshooting

- "The admin-users Edge Function is not deployed": repeat step 3.
- "... permission denied for table ...  apply database/migrations/2026-11-23-service-role-grants.sql": the grants in section 2b have not been applied (or were rolled back).
- "User management is not installed": repeat step 2.
- A USER sees nothing after sign-in: check `active` and `must_change_password` on their `user_profiles` row.
- Deleting an employee removes their profile but leaves an Auth login with no profile. It cannot reach any data; remove it under Authentication → Users if you want.
- Existing sessions of a deactivated USER stay valid until the token expires (≤1 h), but the database returns no data to them immediately.

## Automated tests kept in the repo (all local, none touch Supabase)

- `database/tests/two-role-rls-simulation.mjs`: migration, RLS and rollback on a local Postgres (PGlite) with a mock `auth` schema. Setup: `cd database	ests; npm i --no-save @electric-sql/pglite`, then `node two-role-rls-simulation.mjs` from the repo root's `database	ests`.
- `scripts/test-backup-lib.ps1`: backup export, validation, tamper/stale/partial-failure detection and restore-SQL generation against a fake database and fake CLI (Windows PowerShell 5.1).
- `database/tests/migration-state-sql-check.mjs`: the migration-state `SELECT` on a real Postgres engine at every stage (original, migrated, rolled back, re-applied, and with each marker knocked out).
- `database/tests/stage-verdict-sql-check.mjs`: runs the exact pre-flight and post-migration verdict `SELECT`s from `deploy-two-role.ps1` on the local Postgres (old schema, migrated schema, and a negative case).
- `database/tests/restore-sql-check.mjs`: loads the generated restore SQL into an emptied local Postgres and compares every restored row (steps in the file header).
- `supabase/functions/admin-users/test-harness.mjs`: runs the real function code against a mock Supabase client, including a table-privilege model: permission errors, missing employees/profiles, and every operation under exactly the minimum grants.
- `database/tests/service-role-grants-check.mjs`: the grants migration on the production-faithful local schema: exactly seven column privileges change, unauthorized columns (including `password_snapshot`) cannot be read, filtered on, sorted by or returned, every granted column is necessary (revoked one at a time), the grants equal what `index.ts` needs (computed from its source), idempotent, reversible, the reviewed migration is byte-identical, and the runbook verification query is correct.
- `frontend/tests/app-roles.test.jsx`: renders the real `App.jsx` with mocked Supabase modules (see the header comment for setup).
