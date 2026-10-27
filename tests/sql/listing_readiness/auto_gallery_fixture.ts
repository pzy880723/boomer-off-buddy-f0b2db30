import { writeFileSync } from 'node:fs';
import { buildAutoProductContent } from '../../../src/lib/listing-auto-content.ts';

// Actual production builder, synthetic SKU/images only; never calls AI or production DB.
const result = buildAutoProductContent({
  sku_id: 'b2700000-0000-0000-0000-000000000004',
  name: '隔离测试模型', category_name: '模型', brand: null, grade: null,
  facets: [], knowledge: [],
  image_paths: ['sku-listing/test/reuse-cover.png', 'sku-listing/test/reuse-detail.png'],
});
const images = result.blocks.filter((b) => b.type === 'image');
if (images.length !== 2 || images[0]?.id !== 'auto-cover' || images[1]?.id !== 'auto-detail-1') {
  throw new Error('Production builder did not produce both gallery image blocks');
}
writeFileSync('/tmp/auto-gallery-fixture.sql', `UPDATE inv_product_content SET published_blocks=$blocks$${JSON.stringify(result.blocks)}$blocks$::jsonb WHERE sku_id='b2700000-0000-0000-0000-000000000004';`);