
CREATE POLICY "shop-images auth read" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'shop-images');
CREATE POLICY "shop-images auth write" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'shop-images');
CREATE POLICY "shop-images auth update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'shop-images');
CREATE POLICY "shop-images auth delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'shop-images');
