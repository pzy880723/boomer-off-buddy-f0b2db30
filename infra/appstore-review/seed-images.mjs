import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const sharp = createRequire('/var/www/boomer-erp/review-41182c7b/package.json')('sharp');
const env = Object.fromEntries(readFileSync('/opt/boomer-appstore-review/.env', 'utf8').split('\n')
  .filter(line => line.includes('=')).map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; }));
const headers = { apikey: env.SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SERVICE_ROLE_KEY}` };
const storage = 'http://127.0.0.1:3812';
const rest = 'http://127.0.0.1:3811';
async function check(response) {
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    let message = String(detail.message || detail.error || 'unknown');
    for (const value of Object.values(env)) if (value.length > 8) message = message.split(value).join('[redacted]');
    throw new Error(`Demo image operation failed: HTTP ${response.status}, ${message}`);
  }
  return response;
}
const existing = await check(await fetch(`${storage}/bucket`, { headers }));
const buckets = await existing.json();
if (!buckets.some(bucket => bucket.id === 'sku-raw')) await check(await fetch(`${storage}/bucket`, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'sku-raw', name: 'sku-raw', public: false, file_size_limit: 12582912 }),
}));
const drawings = [
  '<path d="M280 240 H520 L495 550 Q400 590 305 550 Z" fill="#dbecef" stroke="#66868c" stroke-width="12"/><ellipse cx="400" cy="240" rx="120" ry="32" fill="#f9ffff" stroke="#66868c" stroke-width="12"/><path d="M305 340 H495 M310 385 H490" stroke="#93b2b7" stroke-width="7"/>',
  '<ellipse cx="400" cy="405" rx="235" ry="170" fill="#f5ead0" stroke="#466e89" stroke-width="18"/><ellipse cx="400" cy="405" rx="176" ry="115" fill="#fff9eb" stroke="#466e89" stroke-width="6"/>',
  '<rect x="150" y="230" width="500" height="335" rx="12" fill="#fff6de" stroke="#b79270" stroke-width="10"/><path d="M180 535 L330 320 L460 470 L560 355 L620 535 Z" fill="#759b87"/><circle cx="550" cy="290" r="28" fill="#d4ae64"/>',
];
for (let index = 0; index < drawings.length; index++) {
  const id = `de000000-0000-4000-8000-00000000010${index + 1}`;
  const record = await check(await fetch(`${rest}/inv_skus?id=eq.${id}&select=id,attributes`, { headers }));
  const [sku] = await record.json();
  assert.equal(sku?.attributes?.demo, true, 'Only explicit demo products may be updated');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#f2f1ed"/>${drawings[index]}<text x="400" y="720" text-anchor="middle" fill="#7d807d" font-family="sans-serif" font-size="27">DEMO SAMPLE - NOT FOR SALE</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const path = `appstore-demo/${id}.png`;
  await check(await fetch(`${storage}/object/sku-raw/${path}`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: png }));
  await check(await fetch(`${rest}/inv_skus?id=eq.${id}`, { method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_paths: [`sku-raw/${path}`], image_processing_status: 'idle' }) }));
}
console.log(JSON.stringify({ demo_images_uploaded: drawings.length, bucket_public: false }));
const signed = await check(await fetch(`${storage}/object/sign/sku-raw`, { method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ paths: ['appstore-demo/de000000-0000-4000-8000-000000000101.png'], expiresIn: 3600 }),
}));
const signatures = await signed.json();
console.log(JSON.stringify({ signed_image_result: signatures.map(item => ({ path: item.path, error: item.error, signed: !!item.signedURL })) }));
