-- Add break sessions and historical unit-price snapshots without changing old rows.
-- Existing records retain NULL break_type and unit_price until an admin edits them.
ALTER TABLE public.snacks
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);

ALTER TABLE public.snack_records
  ADD COLUMN IF NOT EXISTS break_type TEXT,
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_snacks_unit_price_nonnegative' AND conrelid = 'public.snacks'::regclass) THEN
    ALTER TABLE public.snacks ADD CONSTRAINT chk_snacks_unit_price_nonnegative
      CHECK (unit_price IS NULL OR unit_price >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_records_unit_price_nonnegative' AND conrelid = 'public.snack_records'::regclass) THEN
    ALTER TABLE public.snack_records ADD CONSTRAINT chk_records_unit_price_nonnegative
      CHECK (unit_price IS NULL OR unit_price >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_records_break_type' AND conrelid = 'public.snack_records'::regclass) THEN
    ALTER TABLE public.snack_records ADD CONSTRAINT chk_records_break_type
      CHECK (break_type IS NULL OR break_type IN ('MORNING', 'EVENING'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_records_break_time
  ON public.snack_records (break_type, taken_at);

NOTIFY pgrst, 'reload schema';

-- Verification: this must return exactly three rows.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'snacks' AND column_name = 'unit_price')
    OR (table_name = 'snack_records' AND column_name IN ('unit_price', 'break_type')))
ORDER BY table_name, column_name;
