-- Undo for 2026-11-25-no-snacks-days.sql. WARNING: this deletes the no_snack_days table, i.e. every recorded "No Snacks" day.
-- employees, snacks and snack_records are NOT touched.
BEGIN;
DROP TRIGGER IF EXISTS trg_snack_record_no_snacks_guard ON public.snack_records;
DROP FUNCTION IF EXISTS public.snack_record_no_snacks_guard();
DROP TRIGGER IF EXISTS trg_no_snack_day_insert_guard ON public.no_snack_days;
DROP FUNCTION IF EXISTS public.no_snack_day_insert_guard();
DROP TABLE IF EXISTS public.no_snack_days;
NOTIFY pgrst, 'reload schema';
COMMIT;
