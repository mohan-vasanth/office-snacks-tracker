-- Undo for 2026-11-26-no-snacks-break-type.sql: No Snacks goes back to one row per employee per DAY.
-- WARNING: where an employee has both a Morning and an Evening No Snacks row for the same day, only the earliest row is kept
-- (the break information is dropped). employees, snacks and snack_records are NOT touched.
BEGIN;

DELETE FROM public.no_snack_days AS a USING public.no_snack_days AS b
  WHERE a.employee_id = b.employee_id AND a.day = b.day AND a.id > b.id;
ALTER TABLE public.no_snack_days DROP CONSTRAINT IF EXISTS uk_no_snack_employee_day_break;
ALTER TABLE public.no_snack_days DROP CONSTRAINT IF EXISTS chk_no_snack_break_type;
ALTER TABLE public.no_snack_days DROP COLUMN IF EXISTS break_type;
ALTER TABLE public.no_snack_days DROP CONSTRAINT IF EXISTS uk_no_snack_employee_day;
ALTER TABLE public.no_snack_days ADD CONSTRAINT uk_no_snack_employee_day UNIQUE (employee_id, day);

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
  PERFORM pg_advisory_xact_lock(hashtextextended('office-no-snacks:' || NEW.employee_id::text || ':' || NEW.day::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.snack_records AS record
    WHERE record.employee_id = NEW.employee_id
      AND (record.taken_at AT TIME ZONE 'Asia/Kolkata')::date = NEW.day
  ) THEN
    RAISE EXCEPTION 'Snacks are already recorded for today, so No Snacks cannot be submitted.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.no_snack_day_insert_guard() FROM PUBLIC, anon, authenticated;

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
  PERFORM pg_advisory_xact_lock(hashtextextended('office-no-snacks:' || NEW.employee_id::text || ':' || today::text, 0));
  IF EXISTS (SELECT 1 FROM public.no_snack_days AS d WHERE d.employee_id = NEW.employee_id AND d.day = today) THEN
    RAISE EXCEPTION 'No Snacks was already submitted for today, so snacks cannot be added.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snack_record_no_snacks_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
