import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const sharp = createRequire(resolve("package.json"))("sharp");
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map(JSON.parse);
const cache = new Map();
async function pixels(url) {
  if (cache.has(url)) return cache.get(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const image = sharp(bytes).rotate().flatten({ background: "#ffffff" }).removeAlpha();
  const metadata = await image.metadata();
  const data = await image.resize(64, 64, { fit: "fill" }).raw().toBuffer();
  const result = { data, width: metadata.width, height: metadata.height, bytes: bytes.length };
  cache.set(url, result);
  return result;
}
function distance(a, b) {
  if (a.length !== b.length) throw new Error("Channel mismatch");
  return Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0) / a.length);
}
for (const row of rows) {
  if (row.error) continue;
  for (const branch of row.branches) {
    for (const [index, cover] of row.sku.image_paths.entries()) {
    try {
      if (!cover?.startsWith("sku-listing/")) continue;
      if (!branch.detail.media?.images?.[index]?.url) throw new Error("Missing remote image");
      const source = await pixels(`https://erp.boomeroff.com/api/public/media/sku/${cover}`);
      const actual = await pixels(branch.detail.media.images[index].url);
      const rmse = distance(source.data, actual.data);
      console.log(JSON.stringify({ id: row.sku.id, index, name: row.sku.name, shop: branch.name,
        source: { width: source.width, height: source.height, bytes: source.bytes },
        actual: { width: actual.width, height: actual.height, bytes: actual.bytes },
        rmse: Math.round(rmse * 100) / 100, matchesCurrentCover: rmse < 4,
      }));
    } catch (error) { console.log(JSON.stringify({ id: row.sku.id, index, error: error.message })); process.exitCode = 1; }
    }
  }
}
