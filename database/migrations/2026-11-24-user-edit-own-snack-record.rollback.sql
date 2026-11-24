-- Undo for 2026-11-24-user-edit-own-snack-record.sql: UPDATE becomes ADMIN-only again. Touches no data.
BEGIN;
DROP TRIGGER IF EXISTS trg_snack_record_user_update_guard ON public.snack_records;
DROP FUNCTION IF EXISTS public.snack_record_user_update_guard();
DROP POLICY IF EXISTS office_records_update_guard ON public.snack_records;
CREATE POLICY office_records_update_guard ON public.snack_records AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.current_office_role() = 'admin') WITH CHECK (public.current_office_role() = 'admin');
COMMIT;
