import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { supabaseAdmin as db } from "../src/integrations/supabase/client.server";
import { aiPrepareListingImage } from "../src/server/handheld-ai.server";
import { squareOriginalImage } from "../src/server/listing-image-safety.server";

const allowedSkus = new Set([
  "18ace324-fbd1-4c8e-8dcd-12f01329a99e",
  "fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3",
]);
const [mode, argument, onlyJob] = process.argv.slice(2);
const check = (error: { message: string } | null) => { if (error) throw new Error(error.message); };
async function download(bucket: string, path: string) {
  const result = await db.storage.from(bucket).download(path);
  check(result.error);
  return Buffer.from(await result.data!.arrayBuffer());
}
async function pixels(bytes: Buffer) {
  return sharp(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function samePixels(a: Buffer, b: Buffer) {
  const left = await pixels(a), right = await pixels(b);
  return left.info.width === right.info.width && left.info.height === right.info.height && left.data.equals(right.data);
}

if (mode === "prepare") {
  if (!allowedSkus.has(argument)) throw new Error("Explicit approved SKU required");
  const sku = await db.from("inv_skus").select("id,name,image_paths,status").eq("id", argument).single();
  check(sku.error);
  if (sku.data!.status !== "active") throw new Error("SKU is not active");
  const jobs = await db.from("inv_listing_image_jobs" as never).select("*")
    .eq("sku_id", argument).eq("status", "succeeded").order("source_index");
  check(jobs.error);
  for (const job of (jobs.data ?? []) as any[]) {
    if (onlyJob && job.id !== onlyJob) continue;
    const oldKey = `${job.target_bucket}/${job.target_path}`;
    if (!sku.data!.image_paths?.includes(oldKey)) continue;
    const original = await download(job.source_bucket, job.source_path);
    const old = await download(job.target_bucket, job.target_path);
    const padded = Buffer.from((await squareOriginalImage(original)).b64, "base64");
    if (!await samePixels(padded, old)) {
      console.log(JSON.stringify({ job_id: job.id, result: "already_changed_skip" }));
      continue;
    }
    const signed = await db.storage.from(job.source_bucket).createSignedUrl(job.source_path, 3600);
    check(signed.error);
    const generated = await aiPrepareListingImage({ image_url: signed.data!.signedUrl,
      instruction: "这是实物二手商品照片，只替换背景为浅灰色。不要改变相机拍摄角度，不要重绘商品，不要正面化，不要改变商品透视。主体上所有文字、印刷年份、磨损、配件数量和位置必须与原图完全相同。原图看不清的文字保持看不清，不要猜测补字。" +
        (argument === "18ace324-fbd1-4c8e-8dcd-12f01329a99e"
          ? "冰箱左上透明制冰盒是空的，不要在里面生成鸡蛋或任何物品；鸡蛋仅在右门原有位置。保留下方贴纸破损。"
          : "蓝色调音器下方版权小字保持原样，原图是1989, 2019，不得改为1908等其他年份。"),
    });
    const bytes = Buffer.from(generated.b64, "base64");
    if (await samePixels(bytes, padded)) {
      console.log(JSON.stringify({ job_id: job.id, result: "measurement_protected_skip" }));
      continue;
    }
    const imageFile = `/tmp/listing-repair-${job.id}.image`;
    const manifest = `/tmp/listing-repair-${job.id}.json`;
    await writeFile(imageFile, bytes, { mode: 0o600 });
    await writeFile(manifest, JSON.stringify({ job, sku: sku.data, oldKey, imageFile, mime: generated.mime,
      targetPath: `2026-09-27/${argument}/repair-${crypto.randomUUID()}.${generated.mime.includes("png") ? "png" : "jpg"}`,
    }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ job_id: job.id, result: "ready_for_visual_review", imageFile, manifest }));
  }
} else if (mode === "stage-reviewed") {
  // Only stage a visually reviewed replacement for a proven padded-original failure.
  if (!/^[a-f0-9-]{36}$/.test(argument) || !onlyJob) throw new Error("Job ID and reviewed image file required");
  const selected = await db.from("inv_listing_image_jobs" as never).select("*").eq("id", argument).single();
  check(selected.error);
  const job = selected.data as any;
  if (!allowedSkus.has(job.sku_id) || job.status !== "succeeded") throw new Error("Unapproved or changed job");
  const sku = await db.from("inv_skus").select("id,name,image_paths,status").eq("id", job.sku_id).single();
  check(sku.error);
  const oldKey = `${job.target_bucket}/${job.target_path}`;
  if (sku.data!.status !== "active" || !sku.data!.image_paths?.includes(oldKey)) throw new Error("SKU image changed");
  const original = await download(job.source_bucket, job.source_path);
  const padded = Buffer.from((await squareOriginalImage(original)).b64, "base64");
  if (!await samePixels(padded, await download(job.target_bucket, job.target_path))) throw new Error("Not a padded-original failure");
  const bytes = await readFile(onlyJob);
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png" || metadata.width !== metadata.height || (metadata.width ?? 0) < 1024) {
    throw new Error("Reviewed image must be a square PNG of at least 1024px");
  }
  if (await samePixels(bytes, padded)) throw new Error("Replacement is still the original");
  const imageFile = `/tmp/listing-repair-${job.id}.image`;
  const manifest = `/tmp/listing-repair-${job.id}.json`;
  await writeFile(imageFile, bytes, { mode: 0o600 });
  await writeFile(manifest, JSON.stringify({ job, sku: sku.data, oldKey, imageFile, mime: "image/png",
    targetPath: `2026-09-27/${job.sku_id}/reviewed-${crypto.randomUUID()}.png`,
  }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ job_id: job.id, result: "reviewed_staged", manifest }));
} else if (mode === "apply") {
  if (!/^\/tmp\/listing-repair-[a-f0-9-]+\.json$/.test(argument)) throw new Error("Manifest required");
  const saved = JSON.parse(await readFile(argument, "utf8"));
  if (!allowedSkus.has(saved.job.sku_id)) throw new Error("Unapproved SKU");
  const current = await db.from("inv_listing_image_jobs" as never).select("status,target_path")
    .eq("id", saved.job.id).single();
  check(current.error);
  const row = current.data as any;
  if (row.status !== "succeeded" || row.target_path !== saved.job.target_path) throw new Error("Job changed; re-audit");
  const upload = await db.storage.from("sku-listing").upload(saved.targetPath, await readFile(saved.imageFile),
    { contentType: saved.mime, upsert: false, cacheControl: "31536000" });
  check(upload.error);
  const applied = await db.rpc("handheld_apply_listing_image_result" as never, {
    p_sku_id: saved.job.sku_id, p_source_key: saved.oldKey, p_target_key: `sku-listing/${saved.targetPath}`,
  } as never);
  check(applied.error);
  if (!applied.data) throw new Error("Image changed/deleted during repair; not replaced");
  const update = await db.from("inv_listing_image_jobs" as never).update({ target_path: saved.targetPath,
    updated_at: new Date().toISOString(), completed_at: new Date().toISOString(), last_error: null,
  } as never).eq("id", saved.job.id).eq("target_path", saved.job.target_path).select("id");
  check(update.error);
  if ((update.data ?? []).length !== 1) throw new Error("Image applied but job metadata changed; review needed");
  console.log(JSON.stringify({ sku_id: saved.job.sku_id, job_id: saved.job.id, result: "applied", target_path: saved.targetPath }));
} else {
  throw new Error("Usage: prepare <approved SKU> [job ID] | stage-reviewed <job ID> <PNG> | apply /tmp/listing-repair-<job>.json");
}
