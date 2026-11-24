-- Undo for 2026-11-27-no-snacks-edit.sql: removes the conversion function only. No data, table, policy or grant is touched
-- (snack records and No Snacks rows already created stay as they are).
DROP FUNCTION IF EXISTS public.convert_no_snacks_to_snack(BIGINT, BIGINT, INT);
NOTIFY pgrst, 'reload schema';
