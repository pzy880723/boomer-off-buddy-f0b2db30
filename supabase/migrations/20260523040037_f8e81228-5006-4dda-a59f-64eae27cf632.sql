update public.youzan_items
set
  title = coalesce(nullif(raw->>'product_name',''), nullif(title,''), ''),
  pic_url = coalesce(pic_url, raw#>>'{photo_url,0,url}'),
  price = coalesce(
    nullif(price,0),
    (select min(((s->>'retail_price'))::numeric)
       from jsonb_array_elements(raw->'skus') s
       where (s->>'retail_price') ~ '^[0-9]+(\.[0-9]+)?$'),
    price
  ),
  stock_qty = greatest(
    coalesce(stock_qty,0),
    coalesce((
      select sum(coalesce(
        nullif(s->>'stock_num','')::int,
        nullif(s->>'quantity','')::int,
        nullif(s->>'stock','')::int,
        0))
      from jsonb_array_elements(raw->'skus') s
    ),0)
  )
where raw is not null;