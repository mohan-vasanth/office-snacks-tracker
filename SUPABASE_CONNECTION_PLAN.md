# Supabase Frontend Integration Plan

## Goal

Use the existing React UI to access Supabase directly through Supabase Auth and the Data API, with PostgreSQL Row Level Security (RLS) enforcing admin and employee permissions. The Spring Boot backend remains in the repository but is not used by this frontend flow.

## Current implementation status

- Frontend dependency `@supabase/supabase-js` is installed in `frontend/`.
- `frontend/.env.local` has the supplied project URL and publishable key and is git-ignored.
- The login flow uses Supabase Auth email/password and loads each user's `user_profiles` role.
- Frontend CRUD reads and writes employees, snacks, and snack history through the Supabase Data API.
- `database/supabase_setup.sql` creates the tables, policies, role mapping table, and idempotent sample catalog/history records. It has not been run against the Supabase project.
- A production frontend build passed. Live sign-in, RLS, table creation, and CRUD against the project remain unverified until setup SQL and Auth user profiles are applied.

## Remaining steps

1. In Supabase SQL Editor, run the read-only table check in `README.md`. Review any existing schema and policies.
2. Review `database/supabase_setup.sql`. Run it in SQL Editor to create missing tables, install the app's role policies, and add test rows. This file does not drop or truncate records, but it updates the named `office_*` policies and enables RLS.
3. Create an admin and an employee email/password user in Supabase Authentication → Users.
4. Replace the email placeholders in the profile statements at the bottom of the setup SQL, then run those statements in SQL Editor. Link the employee account to the appropriate employee ID.
5. From PowerShell run `cd frontend`, `npm install`, and `npm run dev`.
6. Sign in with each Auth account and verify employee/snack CRUD, multiple snack quantities, history edit/delete, employee totals, and reports.
7. Do not call the integration complete until these operations succeed against Supabase and the RLS behavior is confirmed.

## Security notes

- The publishable key is intended for frontend use only with RLS enabled. Never expose a database password, service-role key, or Supabase secret key in a `VITE_` variable.
- Admin privileges are stored in `user_profiles`, not in user-editable Auth metadata. Only SQL Editor profile mapping grants the admin role.
- Test rows are clearly labeled `Supabase Test ...`; remove them manually after verification if not wanted.