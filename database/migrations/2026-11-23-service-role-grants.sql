-- Minimum COLUMN-level privileges for the admin-users Edge Function (it runs with the service_role key).
--
-- Why: on this project service_role holds NO SELECT/INSERT/UPDATE/DELETE on the app tables (BYPASSRLS skips
-- policies, not GRANTs), so the function's direct table access fails with "permission denied".
--
-- Derived from supabase/functions/admin-users/index.ts, which makes exactly four table calls:
--   user_profiles  SELECT user_id, role      WHERE user_id     = ?   (look up the account to manage)
--   employees      SELECT id, active         WHERE id          = ?   (look up the employee to link)
--   user_profiles  SELECT user_id            WHERE employee_id = ?   (reject a second login for one employee)
--   user_profiles  UPDATE active             WHERE user_id     = ?   (activate / deactivate; no row data is returned)
-- A column used only in a WHERE clause still needs SELECT, hence employee_id. Nothing else is needed:
-- Auth calls use the Auth API and the register/flag helpers are SECURITY DEFINER functions (EXECUTE only).
--
-- Deliberately NOT readable by service_role: user_profiles.password_snapshot (a bcrypt hash of a temporary password),
-- must_change_password, created_at and active; employees.name and created_at. No INSERT, DELETE or any other UPDATE.
--
-- Apply AFTER 2026-11-23-two-role-user-management.sql: the UPDATE grant names the new "active" column, so this file
-- fails (and changes nothing) if that migration has not been applied yet. Safe to run more than once.
-- Undo: 2026-11-23-service-role-grants.rollback.sql

BEGIN;

GRANT SELECT (id, active) ON public.employees TO service_role;
GRANT SELECT (user_id, role, employee_id) ON public.user_profiles TO service_role;
GRANT UPDATE (active) ON public.user_profiles TO service_role;

COMMIT;
