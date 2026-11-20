-- Link the existing Auth user shown in the failed user_profiles request to the
-- admin profile. This does not create an Auth user or set/change a password.
DO $$
DECLARE
  app_admin_id CONSTANT UUID := '8674d066-68e9-4f9c-978c-cc19d0c9e8e4';
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users WHERE id = app_admin_id
  ) THEN
    INSERT INTO public.user_profiles (user_id, role, employee_id)
    VALUES (app_admin_id, 'admin', NULL)
    ON CONFLICT (user_id) DO UPDATE
    SET role = EXCLUDED.role, employee_id = NULL;
  ELSE
    RAISE NOTICE 'Auth user ID is not present in this project. Check that the SQL Editor and frontend use the same Supabase project.';
  END IF;
END $$;
