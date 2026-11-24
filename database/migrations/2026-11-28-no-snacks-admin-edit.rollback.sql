-- Undo for 2026-11-28-no-snacks-admin-edit.sql: No Snacks rows become non-editable again. No data is touched.
DROP TRIGGER IF EXISTS trg_no_snack_day_update_guard ON public.no_snack_days;
DROP FUNCTION IF EXISTS public.no_snack_day_update_guard();
DROP POLICY IF EXISTS office_no_snacks_update_guard ON public.no_snack_days;
DROP POLICY IF EXISTS office_no_snacks_update ON public.no_snack_days;
REVOKE UPDATE ON public.no_snack_days FROM authenticated;
NOTIFY pgrst, 'reload schema';
