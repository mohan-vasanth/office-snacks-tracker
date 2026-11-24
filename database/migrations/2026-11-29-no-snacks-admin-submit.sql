-- Lets an ADMIN submit No Snacks for ANY employee (USER stays limited to themselves). Run in the Supabase SQL Editor AFTER
-- 2026-11-26-no-snacks-break-type.sql (and 2026-11-28 if you use admin editing). Paste and run the WHOLE file in one go.
-- Safe to re-run. No existing row is rewritten.
--   * INSERT guard: ADMIN may insert for any employee; a USER only for their OWN employee (unchanged); anon never.
--     The role comes from user_profiles via current_office_role(), so inactive / must-change-password admins are refused.
--   * Everything else already applies to admin inserts: the day is forced to today (Asia/Kolkata), break must be
--     MORNING/EVENING, UNIQUE (employee, day, break) blocks duplicates, and the insert trigger refuses a No Snacks for a
--     break that already has snack records.
--   * Conflict the other way: the snack_records guard used to skip admins. It now also stops an ADMIN adding a snack record
--     for an employee/day/break that already has No Snacks (admin uses the record's own day; a USER's day is "today", as before).
--     Delete the No Snacks row first (admin can) if the snack really was taken.
--   * Direct database connections (auth.uid() IS NULL) are not altered. USER submission rules are unchanged.
DROP POLICY IF EXISTS office_no_snacks_insert_guard ON public.no_snack_days;
CREATE POLICY office_no_snacks_insert_guard ON public.no_snack_days AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id());

CREATE OR REPLACE FUNCTION public.snack_record_no_snacks_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  is_admin BOOLEAN := public.current_office_role() = 'admin';
  rec_day DATE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  -- USER inserts are stamped "now" by another trigger, so their day is today; an admin may supply taken_at.
  rec_day := CASE WHEN is_admin THEN (NEW.taken_at AT TIME ZONE 'Asia/Kolkata')::date ELSE (now() AT TIME ZONE 'Asia/Kolkata')::date END;
  PERFORM pg_advisory_xact_lock(hashtextextended('office-no-snacks:' || NEW.employee_id::text || ':' || rec_day::text || ':' || coalesce(NEW.break_type, ''), 0));
  IF EXISTS (
    SELECT 1 FROM public.no_snack_days AS d
    WHERE d.employee_id = NEW.employee_id AND d.day = rec_day AND d.break_type IS NOT DISTINCT FROM NEW.break_type
  ) THEN
    RAISE EXCEPTION 'No Snacks was already submitted for this break on that day, so snacks cannot be added to it.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snack_record_no_snacks_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
