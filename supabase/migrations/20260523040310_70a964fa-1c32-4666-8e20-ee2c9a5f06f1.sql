update public.youzan_items
set pic_url = ((raw->>'photo_url')::jsonb) #>> '{0,url}'
where pic_url is null
  and raw ? 'photo_url'
  and jsonb_typeof(raw->'photo_url') = 'string'
  and (raw->>'photo_url') like '[%';