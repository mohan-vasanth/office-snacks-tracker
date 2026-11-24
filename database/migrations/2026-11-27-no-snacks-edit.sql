-- Lets a USER turn one of their own TODAY No Snacks records into a normal snack record, atomically.
-- Run in the Supabase SQL Editor AFTER 2026-11-26-no-snacks-break-type.sql. Paste and run the WHOLE file in one go.
-- Safe to re-run. Does not touch any existing row, table, policy or grant.
--   public.convert_no_snacks_to_snack(no_snack_id, snack_id, quantity) returns the new snack_records id.
--   One function call = one transaction: every check runs first, then the No Snacks row is removed and the snack record is
--   inserted. If anything fails (inactive snack, quantity < 1, a snack already exists for that break, ...) the whole call is
--   rolled back, so the No Snacks row is never lost without the snack being saved.
--   * Only a USER can call it, and only for their OWN row (ADMIN, other employees, anon and inactive accounts are refused).
--   * Only today's (Asia/Kolkata) No Snacks can be converted: users cannot back-date snack records.
--   * Only the SAME break is affected; the other break's No Snacks or snack records are never touched.
--   * The price is snapshotted server-side and the timestamp is set by the existing snack_record_user_guard trigger.
CREATE OR REPLACE FUNCTION public.convert_no_snacks_to_snack(p_no_snack_id BIGINT, p_snack_id BIGINT, p_quantity INT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  emp BIGINT := public.current_office_employee_id();
  today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  ns public.no_snack_days%ROWTYPE;
  snack_active BOOLEAN;
  new_id BIGINT;
BEGIN
  IF emp IS NULL THEN
    RAISE EXCEPTION 'Only an employee can edit their own No Snacks.' USING ERRCODE = '42501';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'Quantity must be at least 1.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO ns FROM public.no_snack_days WHERE id = p_no_snack_id AND employee_id = emp FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This No Snacks record could not be found. It may already have been changed.' USING ERRCODE = 'P0002';
  END IF;
  IF ns.day <> today THEN
    RAISE EXCEPTION 'Only today''s No Snacks can be changed.' USING ERRCODE = '42501';
  END IF;

  SELECT snack.active INTO snack_active FROM public.snacks AS snack WHERE snack.id = p_snack_id;
  IF snack_active IS NOT TRUE THEN
    RAISE EXCEPTION 'This snack is not available.' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('office-no-snacks:' || emp::text || ':' || ns.day::text || ':' || ns.break_type, 0));
  IF EXISTS (
    SELECT 1 FROM public.snack_records AS record
    WHERE record.employee_id = emp
      AND (record.taken_at AT TIME ZONE 'Asia/Kolkata')::date = ns.day
      AND record.break_type IS NOT DISTINCT FROM ns.break_type
  ) THEN
    RAISE EXCEPTION 'Snacks are already recorded for this break today, so this No Snacks cannot be converted.' USING ERRCODE = '23505';
  END IF;

  -- Same transaction: if the insert below fails, this delete is rolled back with it.
  DELETE FROM public.no_snack_days WHERE id = ns.id;
  INSERT INTO public.snack_records (employee_id, snack_id, quantity, break_type)
    VALUES (emp, p_snack_id, p_quantity, ns.break_type)
    RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.convert_no_snacks_to_snack(BIGINT, BIGINT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_no_snacks_to_snack(BIGINT, BIGINT, INT) TO authenticated;

NOTIFY pgrst, 'reload schema';
