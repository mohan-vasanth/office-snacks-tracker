-- Lets a USER edit (UPDATE) their OWN snack records; ADMIN keeps full update access. Safe to re-run.
-- Run in the Supabase SQL Editor AFTER 2026-11-23-two-role-user-management.sql. Rows are not rewritten.
--   * RLS: UPDATE guard now allows ADMIN, or a USER only on rows whose employee_id is their own (USING and WITH CHECK,
--     so a row cannot be reassigned to someone else). DELETE stays ADMIN-only. The permissive policy is unchanged.
--   * Trigger: for USER updates only, employee_id / taken_at / break_type are locked to their old values, the new snack
--     must be active, and unit_price is re-snapshotted server-side when the snack changes (else kept). Quantity must be > 0.
--   * Admins and direct DB connections (auth.uid() IS NULL) are untouched.

BEGIN;

DROP POLICY IF EXISTS office_records_update_guard ON public.snack_records;
CREATE POLICY office_records_update_guard ON public.snack_records AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id())
  WITH CHECK (public.current_office_role() = 'admin' OR employee_id = public.current_office_employee_id());

CREATE OR REPLACE FUNCTION public.snack_record_user_update_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  snack_active BOOLEAN;
  snack_price NUMERIC(10,2);
BEGIN
  IF auth.uid() IS NULL OR public.current_office_role() = 'admin' THEN
    RETURN NEW;
  END IF;
  IF NEW.quantity IS NULL OR NEW.quantity < 1 THEN
    RAISE EXCEPTION 'Quantity must be at least 1.' USING ERRCODE = '23514';
  END IF;
  NEW.employee_id := OLD.employee_id;
  NEW.taken_at := OLD.taken_at;
  NEW.break_type := OLD.break_type;
  IF NEW.snack_id IS DISTINCT FROM OLD.snack_id THEN
    SELECT snack.active, snack.unit_price INTO snack_active, snack_price
    FROM public.snacks AS snack WHERE snack.id = NEW.snack_id;
    IF snack_active IS NOT TRUE THEN
      RAISE EXCEPTION 'This snack is not available.' USING ERRCODE = '42501';
    END IF;
    NEW.unit_price := snack_price;
  ELSE
    NEW.unit_price := OLD.unit_price;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snack_record_user_update_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_snack_record_user_update_guard ON public.snack_records;
CREATE TRIGGER trg_snack_record_user_update_guard BEFORE UPDATE ON public.snack_records
  FOR EACH ROW EXECUTE FUNCTION public.snack_record_user_update_guard();

COMMIT;
