# Office Snacks Tracker

A snack-consumption tracker for a small office. It records employee, snack, quantity, and timestamp only; it has no billing, pricing, or payment features.

## Architecture

- `frontend/`: React application using Supabase Auth and the Supabase Data API for browser-side CRUD protected by Row Level Security (RLS).
- `backend/`: retained Spring Boot API from the earlier setup. The frontend-only Supabase flow does not call it.
- `database/schema.sql`: PostgreSQL tables and indexes.
- `database/supabase_setup.sql`: idempotent table setup, RLS policies, profile roles, and safe sample test rows.

The UI displays dates in `Asia/Kolkata`. PostgreSQL timestamps are stored in UTC.

## Supabase setup

1. Install Node.js 20+ and npm.
2. In Supabase SQL Editor, check whether the `employees`, `snacks`, and `snack_records` tables exist before applying setup SQL:

   ```sql
   SELECT table_name
   FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('employees', 'snacks', 'snack_records')
   ORDER BY table_name;
   ```

3. Review `database/supabase_setup.sql` against any existing schema and policies, then run it in SQL Editor. It does not drop tables or truncate rows. It enables RLS, creates the `user_profiles` role map, and inserts clearly named sample catalog rows plus six sample snack records at most once per India calendar day. Review existing policies before applying it to a project with custom access rules.
4. Create the admin Auth user in Supabase **Authentication → Users** and set a fresh password there. Run `database/link_supabase_admin.sql` in SQL Editor to give `mohan@opalminds.com` the admin profile. Create an employee Auth user and run the employee profile-mapping example at the bottom of `database/supabase_setup.sql`, linked to the desired employee ID. Profiles are required for app sign-in.
5. `frontend/.env.local` is local and git-ignored. It is configured with the project URL and publishable key provided for this workspace. For another checkout, copy `frontend/.env.example` to `frontend/.env.local` and enter the publishable key. Never place a database password, service-role key, or secret key in a `VITE_` variable. The publishable key is for frontend requests protected by RLS.
6. Start the frontend from the project root:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

   Vite reads `.env.local` on startup. The UI uses Supabase directly; Spring Boot is not required for this frontend flow.

## Frontend behavior and access

- Supabase Auth handles email/password sign-in and token refresh.
- Admin profiles can manage employees, snacks, records, and reports.
- Employee profiles can record snacks and view their own history.
- RLS policies enforce those roles in PostgreSQL. The publishable key alone does not grant table access.
- Existing CRUD features include employee/snack create, edit, deactivate/delete; multiple snack records with quantities; history edit/delete; dashboard totals; and grouped reports.

## Optional MySQL data copy for the retained backend

The migration tool is only for copying an existing MySQL database into an empty PostgreSQL database for use by the Spring Boot backend. It is not needed for the frontend-only Supabase flow. It preserves IDs and timestamps, refuses a populated destination, and does not modify MySQL. See `database/migrate_mysql_to_supabase.py` and `database/migration/requirements.txt`.

## Build

- Frontend: from `frontend`, run `npm install` then `npm run build`; serve `dist/` from a static web host.
- Backend (optional legacy API): Java 17+ and ` .\mvnw.cmd -f backend\pom.xml test` from the project root.

See [API documentation](docs/API.md) for the retained Spring API.
