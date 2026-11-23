-- ROLLBACK for 2026-11-23-two-role-user-management.sql. Use only if the migration must be undone.
--
-- Restores the previous role names, helper functions and policies. It does NOT touch employees,
-- snacks or snack_records, and it keeps the new user_profiles columns (harmless; dropping them would
-- discard account state). Logins created with the new User Management keep working as legacy
-- 'employee' accounts.
--
-- WARNING: after rollback the 'active' flag is no longer enforced, so any deactivated USER can use the
-- app again until you delete or ban them in Authentication -> Users. USER can again edit and delete
-- their own snack records. Deploy the previous frontend build before or right after running this.

BEGIN;

DROP TRIGGER IF EXISTS trg_snack_record_user_guard ON public.snack_records;
DROP FUNCTION IF EXISTS public.snack_record_user_guard();
DROP FUNCTION IF EXISTS public.admin_list_users();
DROP FUNCTION IF EXISTS public.service_register_user(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.service_flag_password_reset(UUID);
DROP FUNCTION IF EXISTS public.complete_password_change();
DROP INDEX IF EXISTS public.uk_user_profiles_user_employee;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.user_profiles'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.user_profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE public.user_profiles SET role = 'employee' WHERE role = 'user';
UPDATE public.user_profiles SET password_snapshot = NULL, must_change_password = FALSE;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_role_check CHECK (role IN ('admin', 'employee')),
  ADD CONSTRAINT chk_user_profile_employee CHECK (
    (role = 'admin' AND employee_id IS NULL) OR (role = 'employee' AND employee_id IS NOT NULL)
  );

GRANT SELECT ON public.user_profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.current_office_role()
RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT profile.role FROM public.user_profiles AS profile WHERE profile.user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.current_office_employee_id()
RETURNS BIGINT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT profile.employee_id FROM public.user_profiles AS profile
      WHERE profile.user_id = auth.uid() AND profile.role = 'employee' $$;

DROP POLICY IF EXISTS office_snacks_select_guard ON public.snacks;
CREATE POLICY office_snacks_select_guard ON public.snacks AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.current_office_role() = 'admin' OR (public.current_office_role() = 'employee' AND active));

DROP POLICY IF EXISTS office_records_update_guard ON public.snack_records;
DROP POLICY IF EXISTS office_records_delete_guard ON public.snack_records;
CREATE POLICY office_records_update_guard ON public.snack_records AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id())
  WITH CHECK (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id());
CREATE POLICY office_records_delete_guard ON public.snack_records AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id());

NOTIFY pgrst, 'reload schema';

COMMIT;
