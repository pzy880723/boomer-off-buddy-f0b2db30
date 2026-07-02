-- Unify categories/groups into a single concept
UPDATE public.inv_categories SET kind = 'category' WHERE kind = 'group';