-- Storage policies for SKU image buckets used by handheld smart-create flow.
-- Both buckets are private (workspace blocks public buckets); reads go through
-- signed URLs minted by server functions / route handlers using service role.

-- Authenticated backoffice users can read/write their own uploads (optional convenience).
CREATE POLICY "Authenticated read sku-raw"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sku-raw');

CREATE POLICY "Authenticated write sku-raw"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'sku-raw');

CREATE POLICY "Authenticated read sku-listing"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sku-listing');

CREATE POLICY "Authenticated write sku-listing"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'sku-listing');
