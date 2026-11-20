-- Install/update the admin-only snack hard-delete function.
-- This deletes the snack and its history in the same transaction.
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

REVOKE ALL ON FUNCTION public.delete_snack_permanently(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_snack_permanently(BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';
