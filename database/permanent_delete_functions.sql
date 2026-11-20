-- Install both admin-only permanent-delete RPCs.
-- Employee deletion removes its snack history and app profile. Snack deletion
-- removes records for that snack. Auth accounts are never deleted by these RPCs.

CREATE OR REPLACE FUNCTION public.delete_employee_permanently(target_employee_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  history_rows_deleted BIGINT;
BEGIN
  IF public.current_office_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete employees.' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.snack_records AS record
  WHERE record.employee_id = target_employee_id;
  GET DIAGNOSTICS history_rows_deleted = ROW_COUNT;

  DELETE FROM public.employees AS employee
  WHERE employee.id = target_employee_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee % not found.', target_employee_id USING ERRCODE = 'P0002';
  END IF;

  RETURN history_rows_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_snack_permanently(target_snack_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  history_rows_deleted BIGINT;
BEGIN
  IF public.current_office_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete snacks.' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.snack_records AS record
  WHERE record.snack_id = target_snack_id;
  GET DIAGNOSTICS history_rows_deleted = ROW_COUNT;

  DELETE FROM public.snacks AS snack
  WHERE snack.id = target_snack_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Snack % not found.', target_snack_id USING ERRCODE = 'P0002';
  END IF;

  RETURN history_rows_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_employee_permanently(BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_snack_permanently(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_employee_permanently(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_snack_permanently(BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT
  pg_get_function_arguments('public.delete_employee_permanently(bigint)'::regprocedure) AS employee_delete_rpc,
  pg_get_function_arguments('public.delete_snack_permanently(bigint)'::regprocedure) AS snack_delete_rpc;
