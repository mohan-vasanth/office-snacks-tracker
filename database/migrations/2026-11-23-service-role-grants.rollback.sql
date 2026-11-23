-- Undo for 2026-11-23-service-role-grants.sql: removes exactly the three column-level grants it added. Touches no data.
-- After this the admin-users Edge Function can no longer read employees/user_profiles or update user_profiles.active.

BEGIN;

REVOKE UPDATE (active) ON public.user_profiles FROM service_role;
REVOKE SELECT (user_id, role, employee_id) ON public.user_profiles FROM service_role;
REVOKE SELECT (id, active) ON public.employees FROM service_role;

COMMIT;
