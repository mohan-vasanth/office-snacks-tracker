-- Makes "No Snacks" break-aware (MORNING / EVENING). Safe to re-run. Run in the Supabase SQL Editor AFTER
-- 2026-11-25-no-snacks-days.sql. Paste and run the WHOLE file in one go (a partial selection will fail). Does not touch employees, snacks or snack_records rows.
--   * public.no_snack_days gets break_type (NOT NULL, MORNING|EVENING); uniqueness becomes (employee_id, day, break_type),
--     so Morning and Evening No Snacks are independent and only a repeat of the SAME break is a duplicate.
--   * Existing day-level rows (made before this migration) meant "no snacks all day": each is kept as MORNING and copied as
--     EVENING, so what they said does not change and nothing is invented.
--   * Conflict triggers now compare the SAME break only: No Snacks for a break is refused when snack records exist for that
--     employee/day/break, and snack records for a break are refused when No Snacks exists for that employee/day/break.
--   * RLS policies and grants from the 11-25 migration are unchanged.
BEGIN;

-- Plain statements (no DO block), safe to re-run. Legacy day-level rows are exactly the rows whose break_type is still NULL:
-- first copy each as EVENING, then mark the originals MORNING. After the first run no NULL rows remain, so a re-run changes nothing.
ALTER TABLE public.no_snack_days ADD COLUMN IF NOT EXISTS break_type TEXT;
ALTER TABLE public.no_snack_days DROP CONSTRAINT IF EXISTS uk_no_snack_employee_day;
INSERT INTO public.no_snack_days (employee_id, day, created_at, break_type)
  SELECT employee_id, day, created_at, 'EVENING' FROM public.no_snack_days WHERE break_type IS NULL;
UPDATE public.no_snack_days SET break_type = 'MORNING' WHERE break_type IS NULL;

ALTER TABLE public.no_snack_days ALTER COLUMN break_type SET NOT NULL;
ALTER TABLE public.no_snack_days DROP CONSTRAINT IF EXISTS chk_no_snack_break_type;
ALTER TABLE public.no_snack_days ADD CONSTRAINT chk_no_snack_break_type CHECK (break_type IN ('MORNING', 'EVENING'));
ALTER TABLE public.no_snack_days DROP CONSTRAINT IF EXISTS uk_no_snack_employee_day;
ALTER TABLE public.no_snack_days DROP CONSTRAINT IF EXISTS uk_no_snack_employee_day_break;
ALTER TABLE public.no_snack_days ADD CONSTRAINT uk_no_snack_employee_day_break UNIQUE (employee_id, day, break_type);

-- Trigger 1: real current day; refused if snack records already exist for the same employee, day AND break.
CREATE OR REPLACE FUNCTION public.no_snack_day_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.day := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  NEW.created_at := now();
  PERFORM pg_advisory_xact_lock(hashtextextended('office-no-snacks:' || NEW.employee_id::text || ':' || NEW.day::text || ':' || coalesce(NEW.break_type, ''), 0));
  IF EXISTS (
    SELECT 1 FROM public.snack_records AS record
    WHERE record.employee_id = NEW.employee_id
      AND (record.taken_at AT TIME ZONE 'Asia/Kolkata')::date = NEW.day
      AND record.break_type IS NOT DISTINCT FROM NEW.break_type
  ) THEN
    RAISE EXCEPTION 'Snacks are already recorded for this break today, so No Snacks cannot be submitted for it.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.no_snack_day_insert_guard() FROM PUBLIC, anon, authenticated;

-- Trigger 2: a USER cannot add snack records for a break on which they already submitted No Snacks today.
CREATE OR REPLACE FUNCTION public.snack_record_no_snacks_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF auth.uid() IS NULL OR public.current_office_role() = 'admin' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('office-no-snacks:' || NEW.employee_id::text || ':' || today::text || ':' || coalesce(NEW.break_type, ''), 0));
  IF EXISTS (
    SELECT 1 FROM public.no_snack_days AS d
    WHERE d.employee_id = NEW.employee_id AND d.day = today AND d.break_type IS NOT DISTINCT FROM NEW.break_type
  ) THEN
    RAISE EXCEPTION 'No Snacks was already submitted for this break today, so snacks cannot be added to it.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snack_record_no_snacks_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
