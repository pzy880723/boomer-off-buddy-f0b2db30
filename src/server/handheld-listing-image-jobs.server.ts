import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { aiPrepareListingImage } from "@/server/handheld-ai.server";
import { ListingImageReviewRequiredError } from "./listing-image-policy";

type ImageRef = {
  bucket: "sku-raw" | "sku-listing";
  storage_path: string;
};

type JobRow = {
  id: string;
  sku_id: string;
  source_bucket: "sku-raw" | "sku-listing";
  source_path: string;
  source_index: number;
  attempts: number;
};

const BACKOFF_SECONDS = [30, 5 * 60, 30 * 60, 2 * 60 * 60];

function cleanStoragePath(bucket: string, path: string): string {
  return path
    .trim()
    .replace(/^\/+/, "")
    .replace(new RegExp(`^${bucket}/`), "");
}

export async function enqueueListingImageJobs(input: {
  skuId: string;
  images: ImageRef[];
}): Promise<{ queued: number; status: "idle" | "queued" }> {
  const rows = input.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => image.bucket === "sku-raw")
    .map(({ image, index }) => ({
      sku_id: input.skuId,
      source_bucket: image.bucket,
      source_path: cleanStoragePath(image.bucket, image.storage_path),
      source_index: index,
      target_bucket: "sku-listing",
      status: "queued",
      next_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

  if (rows.length === 0) return { queued: 0, status: "idle" };
  const result = await supabaseAdmin
    .from("inv_listing_image_jobs" as never)
    .upsert(rows as never, {
      onConflict: "sku_id,source_bucket,source_path",
      ignoreDuplicates: true,
    });
  if (result.error) throw new Error(`创建图片优化任务失败：${result.error.message}`);

  const now = new Date().toISOString();
  const sku = await supabaseAdmin
    .from("inv_skus")
    .update({ image_processing_status: "queued", image_processing_updated_at: now } as never)
    .eq("id", input.skuId);
  if (sku.error) throw new Error(`更新图片任务状态失败：${sku.error.message}`);
  return { queued: rows.length, status: "queued" };
}

async function replaceRawPathWithListing(job: JobRow, targetPath: string): Promise<void> {
  const skuResult = await supabaseAdmin
    .from("inv_skus")
    .select("image_paths")
    .eq("id", job.sku_id)
    .maybeSingle();
  if (skuResult.error || !skuResult.data) {
    throw new Error(`读取 SKU 图片失败：${skuResult.error?.message ?? "not found"}`);
  }
  const rawKey = `${job.source_bucket}/${job.source_path}`;
  const listingKey = `sku-listing/${targetPath}`;
  const existing = ((skuResult.data as { image_paths?: string[] | null }).image_paths ?? []).filter(
    Boolean,
  );
  const next = existing.map((path) => (path === rawKey ? listingKey : path));
  if (!next.includes(listingKey)) {
    const insertAt = Math.min(Math.max(job.source_index, 0), next.length);
    next.splice(insertAt, 0, listingKey);
  }
  const deduped = [...new Set(next)];
  const update = await supabaseAdmin
    .from("inv_skus")
    .update({ image_paths: deduped, updated_at: new Date().toISOString() } as never)
    .eq("id", job.sku_id);
  if (update.error) throw new Error(`替换 SKU 上架图失败：${update.error.message}`);
}

async function refreshSkuStatus(skuId: string): Promise<void> {
  const result = await supabaseAdmin
    .from("inv_listing_image_jobs" as never)
    .select("status")
    .eq("sku_id", skuId);
  if (result.error) return;
  const statuses = (result.data ?? []).map((row) => String((row as { status: string }).status));
  let status = "idle";
  if (statuses.length > 0 && statuses.every((value) => value === "succeeded")) status = "succeeded";
  else if (statuses.some((value) => value === "processing")) status = "processing";
  else if (statuses.some((value) => value === "queued")) status = "queued";
  else if (statuses.some((value) => value === "succeeded")) status = "partial_failed";
  else if (statuses.some((value) => value === "retryable_failed" || value === "permanent_failed"))
    status = "retryable_failed";
  await supabaseAdmin
    .from("inv_skus")
    .update({
      image_processing_status: status,
      image_processing_updated_at: new Date().toISOString(),
    } as never)
    .eq("id", skuId);
}

async function processJob(job: JobRow, workerId: string): Promise<boolean> {
  const locked = await supabaseAdmin
    .from("inv_listing_image_jobs" as never)
    .update({
      status: "processing",
      attempts: job.attempts + 1,
      locked_at: new Date().toISOString(),
      locked_by: workerId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", job.id)
    .in("status", ["queued", "retryable_failed"])
    .select("id")
    .maybeSingle();
  if (locked.error) throw new Error(locked.error.message);
  if (!locked.data) return false;

  try {
    const signed = await supabaseAdmin.storage
      .from(job.source_bucket)
      .createSignedUrl(job.source_path, 60 * 60);
    if (signed.error) throw new Error(signed.error.message);
    const prepared = await aiPrepareListingImage({ image_url: signed.data.signedUrl });
    const extension = prepared.mime.includes("png")
      ? "png"
      : prepared.mime.includes("webp")
        ? "webp"
        : "jpg";
    const targetPath = `${new Date().toISOString().slice(0, 10)}/${job.sku_id}/${job.source_index + 1}-${crypto.randomUUID()}.${extension}`;
    const upload = await supabaseAdmin.storage
      .from("sku-listing")
      .upload(targetPath, Buffer.from(prepared.b64, "base64"), {
        contentType: prepared.mime,
        cacheControl: "31536000",
        upsert: false,
      });
    if (upload.error) throw new Error(upload.error.message);
    await replaceRawPathWithListing(job, targetPath);
    await supabaseAdmin
      .from("inv_listing_image_jobs" as never)
      .update({
        status: "succeeded",
        target_path: targetPath,
        last_error: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", job.id);
  } catch (error) {
    const attempts = job.attempts + 1;
    // Unsafe/uncertain edits need review, not another paid attempt at inventing the hidden area.
    const permanent =
      error instanceof ListingImageReviewRequiredError || attempts >= BACKOFF_SECONDS.length + 1;
    const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
    await supabaseAdmin
      .from("inv_listing_image_jobs" as never)
      .update({
        status: permanent ? "permanent_failed" : "retryable_failed",
        last_error:
          error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        next_run_at: new Date(Date.now() + delay * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", job.id);
  } finally {
    await refreshSkuStatus(job.sku_id);
  }
  return true;
}

export async function runListingImageWorker(limit = 2): Promise<{ processed: number }> {
  const result = await supabaseAdmin
    .from("inv_listing_image_jobs" as never)
    .select("id, sku_id, source_bucket, source_path, source_index, attempts")
    .in("status", ["queued", "retryable_failed"])
    .lte("next_run_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 6)));
  if (result.error) throw new Error(`读取图片任务失败：${result.error.message}`);
  const jobs = (result.data ?? []) as unknown as JobRow[];
  const workerId = `erp-${crypto.randomUUID()}`;
  const processed = await Promise.all(jobs.map((job) => processJob(job, workerId)));
  return { processed: processed.filter(Boolean).length };
}

export function triggerListingImageWorker(limit = 2): void {
  void runListingImageWorker(limit).catch((error) => {
    console.error("[handheld listing image worker]", error);
  });
}
