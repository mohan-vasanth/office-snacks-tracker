-- Install/update the admin-only employee hard-delete function.
-- This deletes that employee's snack history and linked app profile in the same
-- transaction. The Supabase Auth account itself is not deleted.
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

REVOKE ALL ON FUNCTION public.delete_employee_permanently(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_employee_permanently(BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';
