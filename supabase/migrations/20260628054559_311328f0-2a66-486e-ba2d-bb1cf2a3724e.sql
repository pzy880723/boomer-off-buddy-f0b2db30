
-- 1. inv_skus.barcode (EAN-13, auto-generated, globally unique)
ALTER TABLE public.inv_skus ADD COLUMN IF NOT EXISTS barcode text;
CREATE UNIQUE INDEX IF NOT EXISTS inv_skus_barcode_uidx ON public.inv_skus(barcode) WHERE barcode IS NOT NULL;

-- 2. condition_grade CHECK on existing grade column
ALTER TABLE public.inv_skus
  DROP CONSTRAINT IF EXISTS inv_skus_grade_check;
ALTER TABLE public.inv_skus
  ADD CONSTRAINT inv_skus_grade_check
  CHECK (grade IS NULL OR grade IN ('N','S','A','B','C','J'));

-- 3. EAN-13 generator: prefix 200 + 9 random digits + checksum
CREATE OR REPLACE FUNCTION public.gen_ean13()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  digits text;
  s int := 0;
  i int;
  d int;
  cd int;
BEGIN
  -- 12 base digits: '200' + 9 random
  digits := '200' || lpad(floor(random() * 1000000000)::bigint::text, 9, '0');
  -- EAN-13 checksum: odd positions *1, even *3 (1-indexed from left over 12 digits)
  FOR i IN 1..12 LOOP
    d := substring(digits FROM i FOR 1)::int;
    IF i % 2 = 1 THEN
      s := s + d;
    ELSE
      s := s + d * 3;
    END IF;
  END LOOP;
  cd := (10 - (s % 10)) % 10;
  RETURN digits || cd::text;
END;
$$;

REVOKE ALL ON FUNCTION public.gen_ean13() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gen_ean13() TO service_role;

-- 4. Trigger to fill barcode on inv_skus insert; retry on collision
CREATE OR REPLACE FUNCTION public.tg_inv_skus_fill_barcode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  candidate text;
  attempts int := 0;
BEGIN
  IF NEW.barcode IS NOT NULL THEN RETURN NEW; END IF;
  LOOP
    candidate := public.gen_ean13();
    PERFORM 1 FROM public.inv_skus WHERE barcode = candidate;
    IF NOT FOUND THEN
      NEW.barcode := candidate;
      RETURN NEW;
    END IF;
    attempts := attempts + 1;
    IF attempts > 10 THEN
      RAISE EXCEPTION 'failed to generate unique EAN-13 after 10 attempts';
    END IF;
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS inv_skus_fill_barcode ON public.inv_skus;
CREATE TRIGGER inv_skus_fill_barcode
  BEFORE INSERT ON public.inv_skus
  FOR EACH ROW EXECUTE FUNCTION public.tg_inv_skus_fill_barcode();

-- 5. Backfill existing rows
DO $$
DECLARE
  r record;
  candidate text;
  attempts int;
BEGIN
  FOR r IN SELECT id FROM public.inv_skus WHERE barcode IS NULL LOOP
    attempts := 0;
    LOOP
      candidate := public.gen_ean13();
      BEGIN
        UPDATE public.inv_skus SET barcode = candidate WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        attempts := attempts + 1;
        IF attempts > 10 THEN RAISE EXCEPTION 'backfill failed for %', r.id; END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
