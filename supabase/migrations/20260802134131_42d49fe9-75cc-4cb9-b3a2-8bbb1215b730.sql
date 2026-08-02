-- 保证 print_type 非空并有默认值，历史数据补齐为 label
UPDATE public.inv_label_templates SET print_type = 'label' WHERE print_type IS NULL;
ALTER TABLE public.inv_label_templates ALTER COLUMN print_type SET DEFAULT 'label';
ALTER TABLE public.inv_label_templates ALTER COLUMN print_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inv_label_templates_print_type_check'
      AND conrelid = 'public.inv_label_templates'::regclass
  ) THEN
    ALTER TABLE public.inv_label_templates
      ADD CONSTRAINT inv_label_templates_print_type_check
      CHECK (print_type IN ('label','receipt'));
  END IF;
END $$;

-- 每种 print_type 只允许一份默认模板
CREATE UNIQUE INDEX IF NOT EXISTS inv_label_templates_one_default_per_type
  ON public.inv_label_templates (print_type)
  WHERE is_default;