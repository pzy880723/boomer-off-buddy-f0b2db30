
ALTER TABLE public.youzan_shops
  ADD COLUMN IF NOT EXISTS sell_channel_ids bigint[] NOT NULL DEFAULT ARRAY[]::bigint[];

INSERT INTO public.integration_api_registry
  (platform, capability_key, capability_name, requirement, method, version, scope, token_scope, http_verb, doc_url, note, sort_order)
VALUES
  ('youzan', 'retail.open.sellchannel.list',
   '拿到这家分店所有销售渠道（网店 + 线下）',
   '一次列出分店下的所有销售渠道号，用来判断哪个是网店、哪个是线下门店。',
   'youzan.retail.open.sellchannel.list', '1.0.0', 'branch', 'branch', 'POST',
   'https://doc.youzanyun.com/list?keyword=retail.open.sellchannel',
   '有赞连锁零售侧的分店销售渠道枚举。如返回空/不存在，会自动回落用 organization.list 里的 sell_channel_ids。',
   115),
  ('youzan', 'item.quantity.update.offline',
   '把库存推到分店的线下门店',
   '走 item.quantity.update/4.0.0，channel 传"线下"档，验证线下门店能否接收总部推送的库存。',
   'youzan.item.quantity.update', '4.0.0', 'branch', 'branch', 'POST',
   'https://doc.youzanyun.com/detail/API/0/1155',
   'channel 语义：连锁零售侧的销售渠道，需与 sellchannel.list 匹配。',
   120)
ON CONFLICT (platform, capability_key) DO NOTHING;
