-- Keep already deployed handheld clients/routes working while all callers
-- migrate to the audited seven-argument movement function.
create or replace function public.inv_apply_movement(
  p_sku_id uuid,
  p_location_id uuid,
  p_delta integer,
  p_ref_type text,
  p_epc text,
  p_note text
)
returns integer
language sql
security definer
set search_path = public
as $$
  select public.inv_apply_movement(
    p_sku_id => p_sku_id,
    p_location_id => p_location_id,
    p_delta => p_delta,
    p_ref_type => p_ref_type,
    p_ref_id => p_sku_id,
    p_epc => p_epc,
    p_note => p_note
  );
$$;

revoke all on function public.inv_apply_movement(uuid, uuid, integer, text, text, text)
  from public;
grant execute on function public.inv_apply_movement(uuid, uuid, integer, text, text, text)
  to service_role;
