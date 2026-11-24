-- Lets an ADMIN edit a No Snacks record (employee, date, break). Run in the Supabase SQL Editor AFTER
-- 2026-11-26-no-snacks-break-type.sql. Paste and run the WHOLE file in one go. Safe to re-run. No existing row is rewritten.
-- (Delete needs nothing new: the 11-25 migration already allows ADMIN-only DELETE.)
--   * UPDATE is granted only on employee_id, day, break_type, and a RESTRICTIVE policy limits every update to ADMIN.
--     USER accounts (including the row's own employee) and anon cannot update No Snacks rows.
--   * Duplicate prevention is the existing UNIQUE (employee_id, day, break_type).
--   * A BEFORE UPDATE trigger applies the same business rules as submission, to the NEW values:
--       - the date cannot be in the future (Asia/Kolkata);
--       - an edit that would sit on the same employee/day/break as a normal snack record is refused.
--   * Direct database connections (auth.uid() IS NULL) are not altered. USER submission and conversion are untouched.
GRANT UPDATE (employee_id, day, break_type) ON public.no_snack_days TO authenticated;

DROP POLICY IF EXISTS office_no_snacks_update ON public.no_snack_days;
DROP POLICY IF EXISTS office_no_snacks_update_guard ON public.no_snack_days;
CREATE POLICY office_no_snacks_update ON public.no_snack_days FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY office_no_snacks_update_guard ON public.no_snack_days AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.current_office_role() = 'admin') WITH CHECK (public.current_office_role() = 'admin');

CREATE OR REPLACE FUNCTION public.no_snack_day_update_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.day > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'The date cannot be in the future.' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('office-no-snacks:' || NEW.employee_id::text || ':' || NEW.day::text || ':' || NEW.break_type, 0));
  IF EXISTS (
    SELECT 1 FROM public.snack_records AS record
    WHERE record.employee_id = NEW.employee_id
      AND (record.taken_at AT TIME ZONE 'Asia/Kolkata')::date = NEW.day
      AND record.break_type IS NOT DISTINCT FROM NEW.break_type
  ) THEN
    RAISE EXCEPTION 'Snacks are already recorded for that employee, date and break, so No Snacks cannot be set there.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.no_snack_day_update_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_no_snack_day_update_guard ON public.no_snack_days;
CREATE TRIGGER trg_no_snack_day_update_guard BEFORE UPDATE ON public.no_snack_days
  FOR EACH ROW EXECUTE FUNCTION public.no_snack_day_update_guard();

NOTIFY pgrst, 'reload schema';
