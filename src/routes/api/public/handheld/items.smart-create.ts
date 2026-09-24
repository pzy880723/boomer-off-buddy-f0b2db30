import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  err,
  resolveSessionUser,
  userCanAccessLocation,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SmartCreateReq } from "@/lib/handheld/schemas";
import { generateEpc, generateSkuCode } from "@/lib/inventory.helpers";
import { buildPrintPayload } from "@/server/handheld-print.server";
import { replayIfPresent, jsonReplay } from "@/server/handheld-idempotency.server";
import {
  getSmartCreateReleaseTarget,
  persistSmartCreateBrand,
  shouldReuseSmartCreateSku,
  smartCreateFingerprint,
  type SmartCreateCommitResult,
} from "@/server/handheld-smart-create.server";
import {
  assertActiveLeafCategory,
  attachProductClassificationAuditToSku,
  replaceManualProductFacets,
  resolveOrCreateConfirmedIp,
  resolveManualProductFacets,
} from "@/server/product-classification.server";
import {
  enqueueListingImageJobs,
  triggerListingImageWorker,
} from "@/server/handheld-listing-image-jobs.server";

const SKU_IMAGE_BUCKETS = new Set(["sku-raw", "sku-listing"]);

function normalizeBucketPath(
  bucket: "sku-raw" | "sku-listing",
  storagePath: string,
): string | null {
  const clean = storagePath.trim().replace(/^\/+/, "");
  if (!clean) return null;
  if (clean.startsWith(`${bucket}/`)) return clean;
  return `${bucket}/${clean}`;
}

function parseStorageObjectUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const markers = [
      "/storage/v1/object/sign/",
      "/storage/v1/object/public/",
      "/storage/v1/object/authenticated/",
      "/storage/v1/object/upload/sign/",
    ];
    for (const marker of markers) {
      const idx = url.pathname.indexOf(marker);
      if (idx < 0) continue;
      const rest = url.pathname.slice(idx + marker.length).replace(/^\/+/, "");
      const parts = rest.split("/").map((part) => decodeURIComponent(part));
      const bucket = parts.shift();
      const path = parts.join("/");
      if (bucket && SKU_IMAGE_BUCKETS.has(bucket) && path) return `${bucket}/${path}`;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeIncomingImageUrl(imageUrl?: string | null): string | null {
  const raw = imageUrl?.trim();
  if (!raw) return null;
  const storagePath = parseStorageObjectUrl(raw);
  if (storagePath) return storagePath;
  // 只有稳定外链才直接存 image_url；signed URL 会过期，不能落库。
  if (/^https?:\/\//i.test(raw) && !raw.includes("token=")) return raw;
  return null;
}

export const Route = createFileRoute("/api/public/handheld/items/smart-create")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: ReturnType<typeof SmartCreateReq.parse>;
        try {
          body = SmartCreateReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { code: "validation_error", detail: String(e) });
        }
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId)
          return err("No target location (device unbound and no location_id given)", 400);
        if (!(await userCanAccessLocation(session.user_id, locationId)))
          return err("Location not accessible", 403, { code: "location_forbidden" });

        const incomingPaths: string[] = [];
        for (const p of body.image_storage_paths ?? []) {
          const normalized = normalizeBucketPath(p.bucket, p.storage_path);
          if (normalized) incomingPaths.push(normalized);
        }
        const normalizedImageUrl = normalizeIncomingImageUrl(body.image_url);
        if (normalizedImageUrl) incomingPaths.push(normalizedImageUrl);
        const fingerprint = smartCreateFingerprint({ ...body, image_url: normalizedImageUrl }, locationId);
        let existingOp = false;
        if (body.client_op_id) {
          const prior = await supabaseAdmin.from("handheld_smart_create_ops")
            .select("user_id,location_id,payload_fingerprint,response_json")
            .eq("device_id", auth.device.id).eq("client_op_id", body.client_op_id).maybeSingle();
          if (prior.error) return err("Unable to check listing operation; retry with the same client_op_id", 503);
          existingOp = !!prior.data;
          if (prior.data) {
            if (prior.data.user_id !== session.user_id || prior.data.location_id !== locationId ||
                prior.data.payload_fingerprint !== fingerprint) {
              return err("client_op_id reused with a different payload, user or location", 409, { code: "client_op_id_conflict" });
            }
            if (prior.data.response_json) return jsonReplay({ response_status: 200, response_json: prior.data.response_json });
          } else {
            // Only old clients' historical operations use the legacy log; new writes never populate it.
            const replay = await replayIfPresent({ deviceId: auth.device.id, clientOpId: body.client_op_id, opType: "items.smart-create" });
            if (replay) return jsonReplay(replay);
          }
        }
        try {
          await assertActiveLeafCategory(body.category);
        } catch (e) {
          return err((e as Error).message, existingOp ? 500 : 422, { code: "validation_error" });
        }
        let manualFacets: Awaited<ReturnType<typeof resolveManualProductFacets>> | null = null;
        if (body.facet_codes !== undefined || body.tags !== undefined) {
          try {
            manualFacets = await resolveManualProductFacets({
              categoryCode: body.category,
              facetCodes: body.facet_codes,
              legacyTags: body.tags,
            });
          } catch (e) {
            return err((e as Error).message, existingOp ? 500 : 422, { code: "validation_error" });
          }
        }
        let resolvedIp: Awaited<ReturnType<typeof resolveOrCreateConfirmedIp>>;
        try {
          resolvedIp = await resolveOrCreateConfirmedIp({
            name: body.ip_name,
            confirmed: body.ip_confirmed,
          });
        } catch (e) {
          return err((e as Error).message, existingOp ? 500 : 422, { code: "ip_confirmation_required" });
        }
        const { data: loc } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, shop_id, is_active")
          .eq("id", locationId)
          .maybeSingle();
        if (!loc || !loc.is_active) return err("Location not found or disabled", 404);

        const hasRecognition = !!body.recognition_request_id;
        const releaseShopId = getSmartCreateReleaseTarget({
          autoPushYouzan: body.auto_push_youzan,
          locationKind: loc.kind,
          shopId: loc.shop_id,
        });

        // SKU 建档 + EPC 绑定 + 一次入库 + 有赞发布 outbox + 幂等行：同一数据库事务。
        // 同 (device, client_op_id) 重试只得到原 SKU；user / location / 载荷不同返回 409。
        const firstHttp = incomingPaths.find((p) => /^https?:\/\//i.test(p)) ?? null;
        const commit = await supabaseAdmin.rpc("handheld_smart_create_commit" as never, {
          p_device_id: auth.device.id,
          p_user_id: session.user_id,
          p_client_op_id: body.client_op_id ?? null,
          p_fingerprint: fingerprint,
          p_location_id: locationId,
          p_reuse: shouldReuseSmartCreateSku(body.is_custom_price),
          p_sku: {
            category: body.category,
            name: body.name,
            price_tier: body.price_tier,
            is_custom_price: body.is_custom_price,
            inventory_policy: body.is_custom_price ? "tracked" : "unlimited",
            epc: generateEpc(body.category, body.price_tier),
            sku_code: generateSkuCode(body.category, "single"),
            image_paths: incomingPaths,
            image_url: firstHttp,
            weight_g: body.weight_g ?? null,
            notes: body.notes ?? null,
            grade: body.grade ?? null,
            attributes: body.attributes,
            category_source: hasRecognition ? "ai" : "manual",
            category_confidence: body.category_confidence ?? null,
            classification_status: hasRecognition
              ? (body.classification_status ?? "fallback")
              : "legacy",
            ai_suggested_price: body.ai_suggested_price ?? null,
            recognition_request_id: body.recognition_request_id ?? null,
            ip_id: resolvedIp.id,
            ip_candidate_text: resolvedIp.status === "review" ? resolvedIp.name : null,
          },
          p_epcs: body.epcs ?? [],
          p_note: `device:${auth.device.device_code} user:${session.email ?? session.user_id}`,
          p_release_shop_id: releaseShopId,
        } as never);
        if (commit.error) {
          if ((commit.error as { code?: string }).code === "P0409")
            return err("client_op_id reused with a different payload, user or location", 409, {
              code: "client_op_id_conflict",
            });
          return err(`Create SKU failed: ${commit.error.message}`, 500);
        }
        const committed = commit.data as unknown as SmartCreateCommitResult;
        if (committed.response && typeof committed.response === "object") {
          return jsonReplay({ response_status: 200, response_json: committed.response });
        }
        const skuId = committed.sku_id;
        const skuCode = committed.sku_code ?? "";
        const epc = committed.epc;
        const boundCount = committed.bound_epcs;

        // 以下步骤均为幂等写入；提交后中途失败时，客户端用同一 client_op_id 重试会重放这些步骤。
        const { data: current, error: currentError } = await supabaseAdmin
          .from("inv_skus")
          .select("image_paths, image_url")
          .eq("id", skuId)
          .maybeSingle();
        if (currentError || !current) return err("Unable to read committed SKU; retry the same operation", 503);
        const existing = ((current?.image_paths as string[] | null) ?? []) as string[];
        const merged = [...new Set([...existing, ...incomingPaths].filter(Boolean))];
        if (merged.length !== existing.length || hasRecognition) {
          const upd = await supabaseAdmin
            .from("inv_skus")
            .update({
              image_paths: merged,
              image_url:
                merged.find((p) => /^https?:\/\//i.test(p)) ?? current?.image_url ?? null,
              ...(hasRecognition
                ? {
                    attributes: body.attributes,
                    category_source: "ai",
                    category_confidence: body.category_confidence ?? null,
                    classification_status: body.classification_status ?? "fallback",
                    ai_suggested_price: body.ai_suggested_price ?? null,
                    recognition_request_id: body.recognition_request_id,
                  }
                : {}),
              updated_at: new Date().toISOString(),
            } as never)
            .eq("id", skuId);
          if (upd.error) return err(`Save SKU images failed: ${upd.error.message}`, 500);
        }

        if (body.recognition_request_id) {
          try {
            await attachProductClassificationAuditToSku({
              requestId: body.recognition_request_id,
              skuId,
              finalCategoryCode: body.category,
            });
          } catch (e) {
            return err(`Link AI classification failed: ${(e as Error).message}`, 500);
          }
        }
        // The confirmed draft brand takes precedence over the attached recognition audit.
        try {
          await persistSmartCreateBrand({ skuId, brand: body.brand });
        } catch (e) {
          return err(`Save product brand failed: ${(e as Error).message}`, 500);
        }
        if (manualFacets) {
          try {
            await replaceManualProductFacets({
              skuId,
              facets: manualFacets,
              createdBy: session.user_id,
            });
          } catch (e) {
            return err(`Save product tags failed: ${(e as Error).message}`, 500);
          }
        }
        if (resolvedIp.id || resolvedIp.name) {
          const ipUpdate = await supabaseAdmin
            .from("inv_skus")
            .update({
              ip_id: resolvedIp.id,
              ip_candidate_text: resolvedIp.status === "review" ? resolvedIp.name : null,
              updated_at: new Date().toISOString(),
            } as never)
            .eq("id", skuId);
          if (ipUpdate.error) return err(`Save IP failed: ${ipUpdate.error.message}`, 500);
        }

        let imageProcessing: {
          status:
            | "idle"
            | "queued"
            | "processing"
            | "succeeded"
            | "partial_failed"
            | "retryable_failed";
          queued: number;
        } = { status: "idle", queued: 0 };
        try {
          imageProcessing = await enqueueListingImageJobs({
            skuId,
            images: body.image_storage_paths ?? [],
          });
        } catch (e) {
          console.error("[handheld smart-create] 创建图片优化任务失败", e);
          imageProcessing = { status: "retryable_failed", queued: 0 };
        }

        // 有赞发布已在上面同一事务写入持久化 outbox，由腾讯固定出口 worker 异步执行，不阻塞上架返回。
        const syncStatus: "disabled" | "queued" | "unlinked" = releaseShopId
          ? "queued"
          : body.auto_push_youzan
            ? "unlinked"
            : "disabled";

        // inv_apply_movement atomically publishes eligible custom items. Read
        // the resulting listing here so the API can report the final state.
        let storefrontListingId: string | null = null;
        let storefrontStatus: "skipped" | "published" | "sold" | "failed" = "skipped";
        const { data: storefrontListing, error: storefrontError } = await supabaseAdmin
          .from("commerce_listings")
          .select("id, status")
          .eq("sku_id", skuId)
          .eq("location_id", locationId)
          .maybeSingle();
        if (storefrontError) {
          storefrontStatus = "failed";
          console.error("[handheld smart-create] 读取市集上架结果失败", storefrontError);
        } else if (storefrontListing) {
          storefrontListingId = storefrontListing.id;
          storefrontStatus = storefrontListing.status === "published" ? "published" : "sold";
        }

        const { data: finalSku, error: finalSkuError } = await supabaseAdmin
          .from("inv_skus")
          .select("stock_qty, barcode, grade")
          .eq("id", skuId)
          .maybeSingle();
        if (finalSkuError || !finalSku?.barcode) return err("Unable to confirm product barcode; retry the same operation", 503);

        const barcode = finalSku?.barcode ?? null;
        const conditionGrade = (finalSku?.grade ?? body.grade ?? null) as
          | "N"
          | "S"
          | "A"
          | "B"
          | "C"
          | "J"
          | null;

        const locationStockQty = Number(committed.stock_qty ?? finalSku?.stock_qty ?? 0);
        const responseBody = {
          sku_id: skuId,
          sku_code: skuCode,
          barcode,
          epc,
          condition_grade: conditionGrade,
          stock_qty: locationStockQty,
          bound_epcs: boundCount,
          label: {
            sku_code: skuCode,
            barcode,
            epc,
            name: body.name,
            price_cny: body.price_tier,
            grade: body.grade ?? null,
            condition_grade: conditionGrade,
            location_name: loc.name,
            qrcode_payload: barcode ?? skuCode,
          },
          print_payload: buildPrintPayload({
            sku_code: skuCode,
            barcode,
            name: body.name,
            price_tier: body.price_tier,
            grade: body.grade ?? null,
            condition_grade: conditionGrade,
          }),
          youzan_sync_status: syncStatus,
          image_processing: imageProcessing,
          storefront_listing_id: storefrontListingId,
          storefront_status: storefrontStatus,
        };
        const successBody = { ok: true, data: responseBody };
        if (committed.op_id) {
          const done = await supabaseAdmin.rpc("handheld_smart_create_complete" as never, {
            p_op_id: committed.op_id,
            p_response: successBody,
          } as never);
          if (done.error) console.error("[handheld smart-create] 保存幂等响应失败", done.error);
        }
        if (imageProcessing.queued > 0) triggerListingImageWorker(imageProcessing.queued);
        return ok(responseBody);
      },
    },
  },
});
