-- Two-role access (ADMIN / USER) and user management for Office Snacks Tracker.
-- Run in the Supabase SQL Editor AFTER database/supabase_setup.sql (it is safe to re-run).
--
-- What this does (additive; no employee, snack or snack_records row is deleted or rewritten):
--   * Renames the stored role 'employee' -> 'user' (only two roles remain: 'admin', 'user').
--   * Adds user_profiles.active / created_at / must_change_password / password_snapshot.
--   * One login per employee (partial unique index).
--   * Inactive accounts, and accounts that still owe a first-login password change, get NO role
--     from current_office_role(), so every RLS policy and admin function denies them.
--   * USER can read and insert only their own snack_records; only ADMIN can update or delete.
--   * A trigger forces unit_price/taken_at for USER inserts (server-side price snapshot, no backdating).
--   * Admin-only user list function (reads last sign-in from auth.users).
--   * Service-role-only helpers used by the admin-users Edge Function.
--   * complete_password_change() lets a USER clear the first-login flag only after the Auth
--     password hash has really changed.

BEGIN;

-- Pre-flight: the one-login-per-employee index cannot be built over existing duplicates.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE employee_id IS NOT NULL
    GROUP BY employee_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'More than one user_profiles row is linked to the same employee. Remove the duplicates, then re-run.';
  END IF;
END $$;

-- 1. Role values: 'admin' and 'user' only.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.user_profiles'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.user_profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE public.user_profiles SET role = 'user' WHERE role = 'employee';

ALTER TABLE public.user_profiles
  ADD CONSTRAINT chk_user_profile_role CHECK (role IN ('admin', 'user')),
  ADD CONSTRAINT chk_user_profile_employee CHECK (
    (role = 'admin' AND employee_id IS NULL) OR (role = 'user' AND employee_id IS NOT NULL)
  );

-- 2. Account state columns.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS password_snapshot TEXT;

-- Existing accounts keep their real creation date from Auth.
UPDATE public.user_profiles AS profile
SET created_at = auth_user.created_at
FROM auth.users AS auth_user
WHERE auth_user.id = profile.user_id;

CREATE UNIQUE INDEX IF NOT EXISTS uk_user_profiles_user_employee
  ON public.user_profiles (employee_id) WHERE role = 'user';

-- password_snapshot (a bcrypt hash used only to prove the password changed) is never readable by clients.
REVOKE SELECT ON public.user_profiles FROM authenticated;
GRANT SELECT (user_id, role, employee_id, active, must_change_password, created_at)
  ON public.user_profiles TO authenticated;

-- 3. Role helpers: inactive or must-change accounts have no role at all.
CREATE OR REPLACE FUNCTION public.current_office_role()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT profile.role
  FROM public.user_profiles AS profile
  WHERE profile.user_id = auth.uid() AND profile.active AND NOT profile.must_change_password
$$;

CREATE OR REPLACE FUNCTION public.current_office_employee_id()
RETURNS BIGINT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT profile.employee_id
  FROM public.user_profiles AS profile
  WHERE profile.user_id = auth.uid() AND profile.role = 'user'
    AND profile.active AND NOT profile.must_change_password
$$;

REVOKE ALL ON FUNCTION public.current_office_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_office_employee_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_office_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_office_employee_id() TO authenticated;

-- 4. Policies that referenced the old 'employee' role or allowed USER edits.
DROP POLICY IF EXISTS office_snacks_select_guard ON public.snacks;
CREATE POLICY office_snacks_select_guard ON public.snacks AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.current_office_role() = 'admin' OR (public.current_office_role() = 'user' AND active));

DROP POLICY IF EXISTS office_records_insert_guard ON public.snack_records;
DROP POLICY IF EXISTS office_records_update_guard ON public.snack_records;
DROP POLICY IF EXISTS office_records_delete_guard ON public.snack_records;
CREATE POLICY office_records_insert_guard ON public.snack_records AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id());
CREATE POLICY office_records_update_guard ON public.snack_records AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.current_office_role() = 'admin') WITH CHECK (public.current_office_role() = 'admin');
CREATE POLICY office_records_delete_guard ON public.snack_records AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.current_office_role() = 'admin');

-- 5. USER inserts: server-side price snapshot, real timestamp, active snacks only.
-- Direct database connections (auth.uid() IS NULL, e.g. data migrations) and admins are not altered.
CREATE OR REPLACE FUNCTION public.snack_record_user_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  snack_active BOOLEAN;
  snack_price NUMERIC(10,2);
BEGIN
  IF auth.uid() IS NULL OR public.current_office_role() = 'admin' THEN
    RETURN NEW;
  END IF;
  SELECT snack.active, snack.unit_price INTO snack_active, snack_price
  FROM public.snacks AS snack WHERE snack.id = NEW.snack_id;
  IF snack_active IS NOT TRUE THEN
    RAISE EXCEPTION 'This snack is not available.' USING ERRCODE = '42501';
  END IF;
  NEW.unit_price := snack_price;
  NEW.taken_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snack_record_user_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_snack_record_user_guard ON public.snack_records;
CREATE TRIGGER trg_snack_record_user_guard BEFORE INSERT ON public.snack_records
  FOR EACH ROW EXECUTE FUNCTION public.snack_record_user_guard();

-- 6. Admin-only account list (includes last sign-in from Auth).
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  user_id UUID, email TEXT, role TEXT, employee_id BIGINT, employee_name TEXT,
  active BOOLEAN, must_change_password BOOLEAN, created_at TIMESTAMPTZ, last_sign_in_at TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.current_office_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.user_id, u.email::TEXT, p.role, p.employee_id, e.name::TEXT,
         p.active, p.must_change_password, p.created_at, u.last_sign_in_at
  FROM public.user_profiles AS p
  JOIN auth.users AS u ON u.id = p.user_id
  LEFT JOIN public.employees AS e ON e.id = p.employee_id
  ORDER BY p.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;

-- 7. Helpers for the admin-users Edge Function. Callable only with the service-role key.
CREATE OR REPLACE FUNCTION public.service_register_user(p_user_id UUID, p_employee_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, role, employee_id, active, must_change_password, password_snapshot)
  SELECT u.id, 'user', p_employee_id, TRUE, TRUE, u.encrypted_password
  FROM auth.users AS u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auth user % not found.', p_user_id USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.service_flag_password_reset(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.user_profiles AS p
  SET must_change_password = TRUE,
      password_snapshot = (SELECT u.encrypted_password FROM auth.users AS u WHERE u.id = p.user_id)
  WHERE p.user_id = p_user_id AND p.role = 'user';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User account % not found.', p_user_id USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.service_register_user(UUID, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_flag_password_reset(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_register_user(UUID, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_flag_password_reset(UUID) TO service_role;

-- 8. First-login password change: allowed only once the Auth password hash differs from the temporary one.
CREATE OR REPLACE FUNCTION public.complete_password_change()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.user_profiles AS p
  SET must_change_password = FALSE, password_snapshot = NULL
  WHERE p.user_id = auth.uid()
    AND p.must_change_password
    AND (SELECT u.encrypted_password FROM auth.users AS u WHERE u.id = p.user_id)
        IS DISTINCT FROM p.password_snapshot;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The password has not been changed yet.' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_password_change() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_password_change() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
