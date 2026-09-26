import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { aiPrepareListingImage } from "@/server/handheld-ai.server";

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

type ContentImageJob = {
  id: string;
  sku_id: string;
  block_id: string;
  source_path: string;
  claim_token: string;
};

async function prepareImage(
  sourceBucket: string,
  sourcePath: string,
  targetStem: string,
): Promise<string> {
  const signed = await supabaseAdmin.storage
    .from(sourceBucket)
    .createSignedUrl(sourcePath, 60 * 60);
  if (signed.error) throw new Error(signed.error.message);
  const prepared = await aiPrepareListingImage({ image_url: signed.data.signedUrl });
  const extension = prepared.mime.includes("png")
    ? "png"
    : prepared.mime.includes("webp")
      ? "webp"
      : "jpg";
  const targetPath = `${targetStem}.${extension}`;
  const upload = await supabaseAdmin.storage
    .from("sku-listing")
    .upload(targetPath, Buffer.from(prepared.b64, "base64"), {
      contentType: prepared.mime,
      cacheControl: "31536000",
      upsert: false,
    });
  if (upload.error) throw new Error(upload.error.message);
  return targetPath;
}

async function processContentImageJob(job: ContentImageJob): Promise<void> {
  let targetPath: string | null = null;
  let failure: string | null = null;
  try {
    const slash = job.source_path.indexOf("/");
    const path = await prepareImage(
      job.source_path.slice(0, slash),
      job.source_path.slice(slash + 1),
      `content/${job.sku_id}/${job.id}/${job.claim_token}`,
    );
    targetPath = `sku-listing/${path}`;
  } catch (error) {
    failure = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  }
  // A crashed completion is recovered by lease expiry; only the current token may apply.
  const result = await supabaseAdmin.rpc(
    "product_content_image_finish" as never,
    {
      p_id: job.id,
      p_claim_token: job.claim_token,
      p_target_path: targetPath,
      p_error: failure,
    } as never,
  );
  if (result.error) throw new Error(`Complete detail image job: ${result.error.message}`);
}

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
  const result = await supabaseAdmin.from("inv_listing_image_jobs" as never).upsert(rows as never, {
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
  const { error } = await supabaseAdmin.rpc(
    "handheld_apply_listing_image_result" as never,
    {
      p_sku_id: job.sku_id,
      p_source_key: `${job.source_bucket}/${job.source_path}`,
      p_target_key: `sku-listing/${targetPath}`,
    } as never,
  );
  if (error) throw new Error(`替换 SKU 上架图失败：${error.message}`);
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
    const targetPath = await prepareImage(
      job.source_bucket,
      job.source_path,
      `${new Date().toISOString().slice(0, 10)}/${job.sku_id}/${job.source_index + 1}-${crypto.randomUUID()}`,
    );
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
    const permanent = attempts >= BACKOFF_SECONDS.length + 1;
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

type BatchResult = { processed: number; failed: number };

async function runLegacyImageBatch(limit: number): Promise<BatchResult> {
  const result = await supabaseAdmin
    .from("inv_listing_image_jobs" as never)
    .select("id, sku_id, source_bucket, source_path, source_index, attempts")
    .in("status", ["queued", "retryable_failed"])
    .lte("next_run_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (result.error) throw new Error(`读取图片任务失败：${result.error.message}`);
  const jobs = (result.data ?? []) as unknown as JobRow[];
  const workerId = `erp-${crypto.randomUUID()}`;
  const outcomes = await Promise.allSettled(jobs.map((job) => processJob(job, workerId)));
  return {
    processed: outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value).length,
    failed: outcomes.filter((outcome) => outcome.status === "rejected").length,
  };
}

async function runContentImageBatch(limit: number): Promise<BatchResult> {
  const contentJobs = await supabaseAdmin.rpc(
    "product_content_image_claim" as never,
    {
      p_limit: limit,
    } as never,
  );
  if (contentJobs.error) throw new Error(`Claim detail image jobs: ${contentJobs.error.message}`);
  const claimed = (contentJobs.data ?? []) as unknown as ContentImageJob[];
  const outcomes = await Promise.allSettled(claimed.map(processContentImageJob));
  return {
    processed: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    failed: outcomes.filter((outcome) => outcome.status === "rejected").length,
  };
}

export async function runListingImageWorker(limit = 2): Promise<{ processed: number; failed?: number }> {
  if ((process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED ?? "true") !== "true")
    return { processed: 0 };
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 6)) : 2;
  // Each queue claims and completes independently, even when the other queue stalls or fails.
  const batches = await Promise.allSettled([
    runLegacyImageBatch(boundedLimit),
    runContentImageBatch(boundedLimit),
  ]);
  let processed = 0;
  let failed = 0;
  for (const batch of batches) {
    if (batch.status === "rejected") failed += 1;
    else {
      processed += batch.value.processed;
      failed += batch.value.failed;
    }
  }
  return { processed, ...(failed ? { failed } : {}) };
}

export function triggerListingImageWorker(limit = 2): void {
  void runListingImageWorker(limit)
    .then((result) => {
      if (result.failed) console.error("[handheld listing image worker] partial failure", result);
    })
    .catch(() => console.error("[handheld listing image worker] dispatch failed"));
}
