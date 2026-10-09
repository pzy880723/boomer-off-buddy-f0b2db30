import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { aiPrepareListingImage } from "@/server/handheld-ai.server";
import { safeImageJobError } from "@/server/listing-image-safety.server";
import {
  handheldAiGuard,
  isAiConsentRevoked,
  type AiOutboundGuard,
  QUEUED_AI_DENIED_ERROR,
  QUEUED_AI_UNAVAILABLE_ERROR,
  queuedAiDecision,
  type ConsentStore,
} from "@/server/ai-consent-core";

type AiActor = { ai_actor_user_id?: string | null; ai_policy_version?: string | null };

let consentStoreFactory: () => Promise<ConsentStore> = async () =>
  (await import("@/server/ai-consent.server")).dbConsentStore();
/** Test seam only. */
export function __setConsentStoreFactory(f: () => Promise<ConsentStore>) {
  consentStoreFactory = f;
}

/** Re-read the original actor's consent right before the AI call. Null = go ahead. */
async function consentFailure(job: AiActor): Promise<string | null> {
  let decision: "allowed" | "denied" | "unavailable";
  try {
    decision = await queuedAiDecision(await consentStoreFactory(), job);
  } catch {
    decision = "unavailable";
  }
  if (decision === "allowed") return null;
  return decision === "denied" ? QUEUED_AI_DENIED_ERROR : QUEUED_AI_UNAVAILABLE_ERROR;
}

/** Bound to the job's ORIGINAL actor + policy; re-read before every AI stage inside the pipeline. */
async function jobGuard(job: AiActor): Promise<AiOutboundGuard> {
  return handheldAiGuard(await consentStoreFactory(), {
    userId: job.ai_actor_user_id,
    policyVersion: job.ai_policy_version,
  });
}

function jobFailure(error: unknown): string {
  if (isAiConsentRevoked(error))
    return error.reason === "denied" ? QUEUED_AI_DENIED_ERROR : QUEUED_AI_UNAVAILABLE_ERROR;
  return safeImageJobError(error);
}

type ImageRef = {
  bucket: "sku-raw" | "sku-listing";
  storage_path: string;
};

type JobRow = AiActor & {
  id: string;
  sku_id: string;
  source_bucket: "sku-raw" | "sku-listing";
  source_path: string;
  source_index: number;
  attempts: number;
  claim_token: string;
};

type ContentImageJob = AiActor & {
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
  guard: AiOutboundGuard,
): Promise<string> {
  const signed = await supabaseAdmin.storage
    .from(sourceBucket)
    .createSignedUrl(sourcePath, 60 * 60);
  if (signed.error) throw new Error(signed.error.message);
  const prepared = await aiPrepareListingImage({ image_url: signed.data.signedUrl }, guard);
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
  let failure: string | null = await consentFailure(job);
  if (!failure) try {
    const slash = job.source_path.indexOf("/");
    const path = await prepareImage(
      job.source_path.slice(0, slash),
      job.source_path.slice(slash + 1),
      `content/${job.sku_id}/${job.id}/${job.claim_token}`,
      await jobGuard(job),
    );
    targetPath = `sku-listing/${path}`;
  } catch (error) {
    failure = jobFailure(error);
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
  /** Original actor + policy version; the worker re-checks consent before each AI call. */
  aiActorUserId: string;
  aiPolicyVersion: string;
}): Promise<{ queued: number; status: "idle" | "queued" }> {
  const rows = input.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => image.bucket === "sku-raw")
    .map(({ image, index }) => ({
      sku_id: input.skuId,
      source_bucket: image.bucket,
      source_path: cleanStoragePath(image.bucket, image.storage_path),
      source_index: index,
      ai_actor_user_id: input.aiActorUserId,
      ai_policy_version: input.aiPolicyVersion,
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

async function processJob(job: JobRow): Promise<string> {
  let targetPath: string | null = null;
  let failure: string | null = await consentFailure(job);
  if (!failure) try {
    const path = await prepareImage(
      job.source_bucket,
      job.source_path,
      `gallery/${job.sku_id}/${job.id}/${job.claim_token}`,
      await jobGuard(job),
    );
    targetPath = `sku-listing/${path}`;
  } catch (error) {
    failure = jobFailure(error);
  }
  // The transaction fences ownership before applying pixels and completing the job.
  const result = await supabaseAdmin.rpc("handheld_listing_image_finish" as never, {
    p_id: job.id, p_claim_token: job.claim_token, p_target_path: targetPath, p_error: failure,
  } as never);
  if (result.error) throw new Error(`Complete gallery image job: ${result.error.message}`);
  const status = String(result.data);
  if (!["succeeded", "retryable_failed", "permanent_failed", "stale"].includes(status)) {
    throw new Error("Unexpected gallery image completion status");
  }
  return status;
}

type BatchResult = { processed: number; failed: number };

async function runLegacyImageBatch(limit: number): Promise<BatchResult> {
  const result = await supabaseAdmin.rpc("handheld_listing_image_claim" as never, { p_limit: limit } as never);
  if (result.error) throw new Error(`读取图片任务失败：${result.error.message}`);
  const jobs = (result.data ?? []) as unknown as JobRow[];
  const outcomes = await Promise.allSettled(jobs.map(processJob));
  return {
    processed: outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value !== "stale").length,
    failed: outcomes.filter((outcome) => outcome.status === "rejected" ||
      (outcome.status === "fulfilled" && ["retryable_failed", "permanent_failed"].includes(outcome.value))).length,
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
