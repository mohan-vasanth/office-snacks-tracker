-- Undo for 2026-11-29-no-snacks-admin-submit.sql: No Snacks submission is employee-only again and the snack_records guard
-- goes back to skipping admins (the 2026-11-26 version). No data is touched; No Snacks rows already created by admins stay.
DROP POLICY IF EXISTS office_no_snacks_insert_guard ON public.no_snack_days;
CREATE POLICY office_no_snacks_insert_guard ON public.no_snack_days AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (employee_id = public.current_office_employee_id());

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
