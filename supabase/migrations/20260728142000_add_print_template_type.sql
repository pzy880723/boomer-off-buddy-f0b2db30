ALTER TABLE public.inv_label_templates
  ADD COLUMN IF NOT EXISTS print_type text NOT NULL DEFAULT 'label';

ALTER TABLE public.inv_label_templates
  DROP CONSTRAINT IF EXISTS inv_label_templates_print_type_check;

ALTER TABLE public.inv_label_templates
  ADD CONSTRAINT inv_label_templates_print_type_check
  CHECK (print_type IN ('label', 'receipt'));

UPDATE public.inv_label_templates
SET width_mm = 58
WHERE print_type = 'receipt' AND width_mm <> 58;

DROP INDEX IF EXISTS public.inv_label_templates_only_one_default;

CREATE UNIQUE INDEX IF NOT EXISTS inv_label_templates_one_default_per_type
  ON public.inv_label_templates (print_type)
  WHERE is_default = true;

INSERT INTO public.inv_label_templates (
  name,
  print_type,
  width_mm,
  height_mm,
  elements,
  is_default,
  version
)
SELECT
  '门店销售小票',
  'receipt',
  58,
  120,
  '[
    {"id":"receipt-logo","type":"logo","x":24,"y":8,"width":336,"height":28,"textSize":18,"bold":true,"enabled":true,"customText":"","align":"center","fontFamily":"sans","italic":false,"underline":false,"boxed":false},
    {"id":"receipt-title","type":"item_name","x":24,"y":44,"width":336,"height":34,"textSize":22,"bold":true,"enabled":true,"customText":"","align":"center","fontFamily":"sans","italic":false,"underline":false,"boxed":false},
    {"id":"receipt-lines","type":"description","x":24,"y":88,"width":336,"height":180,"textSize":15,"bold":false,"enabled":true,"customText":"","align":"left","fontFamily":"sans","italic":false,"underline":false,"boxed":false},
    {"id":"receipt-footer","type":"custom_text","x":24,"y":278,"width":336,"height":24,"textSize":11,"bold":false,"enabled":true,"customText":"谢谢惠顾 · BOOMER-OFF Vintage","align":"center","fontFamily":"sans","italic":false,"underline":false,"boxed":false}
  ]'::jsonb,
  true,
  1
WHERE NOT EXISTS (
  SELECT 1
  FROM public.inv_label_templates
  WHERE print_type = 'receipt'
);
