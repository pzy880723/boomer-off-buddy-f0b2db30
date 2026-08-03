import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  err,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SmartCreateReq } from "@/lib/handheld/schemas";
import { generateEpc, generateSkuCode } from "@/lib/inventory.helpers";
import { buildPrintPayload } from "@/server/handheld-print.server";
import { replayIfPresent, recordOp, jsonReplay } from "@/server/handheld-idempotency.server";
import { getSmartCreateReleaseTarget } from "@/server/handheld-smart-create.server";
import {
  assertActiveLeafCategory,
  attachProductClassificationAuditToSku,
} from "@/server/product-classification.server";

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
        try {
          await assertActiveLeafCategory(body.category);
        } catch (e) {
          return err((e as Error).message, 422, { code: "validation_error" });
        }
        // 幂等回放
        const replay = await replayIfPresent({
          deviceId: auth.device.id,
          clientOpId: body.client_op_id,
          opType: "items.smart-create",
        });
        if (replay) return jsonReplay(replay);
        const session = await resolveSessionUser(request);
        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId)
          return err("No target location (device unbound and no location_id given)", 400);

        const { data: loc } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, shop_id, is_active")
          .eq("id", locationId)
          .maybeSingle();
        if (!loc || !loc.is_active) return err("Location not found or disabled", 404);

        // 规范化新图：先 image_storage_paths（持久私桶路径），再兼容 image_url。
        // 如果 APP 传的是 /storage/v1/object/sign/... signed URL，这里反解为 bucket/path 持久保存。
        const incomingPaths: string[] = [];
        for (const p of body.image_storage_paths ?? []) {
          const normalized = normalizeBucketPath(p.bucket, p.storage_path);
          if (normalized) incomingPaths.push(normalized);
        }
        const normalizedImageUrl = normalizeIncomingImageUrl(body.image_url);
        if (normalizedImageUrl) incomingPaths.push(normalizedImageUrl);
        const hasRecognition = !!body.recognition_request_id;
        const recognitionFields = hasRecognition
          ? {
              attributes: body.attributes,
              category_source: "ai",
              category_confidence: body.category_confidence ?? null,
              classification_status: body.classification_status ?? "fallback",
              ai_suggested_price: body.ai_suggested_price ?? null,
              recognition_request_id: body.recognition_request_id,
            }
          : {};

        // Reuse existing SKU if (category, price_tier, name) already exists; else create.
        const { data: existSku } = await supabaseAdmin
          .from("inv_skus")
          .select("id, sku_code, epc, stock_qty, image_paths, image_url")
          .eq("category", body.category)
          .eq("price_tier", body.price_tier)
          .eq("name", body.name)
          .maybeSingle();

        let skuId: string;
        let skuCode: string;
        let epc: string;
        if (existSku) {
          skuId = existSku.id;
          skuCode = existSku.sku_code ?? generateSkuCode(body.category, "single");
          epc = existSku.epc;
          // 把新图 append 到已有数组，去重保序
          const existing = ((existSku as { image_paths?: string[] | null }).image_paths ??
            []) as string[];
          const merged: string[] = [];
          const seen = new Set<string>();
          for (const x of [...existing, ...incomingPaths]) {
            if (!x || seen.has(x)) continue;
            seen.add(x);
            merged.push(x);
          }
          if (incomingPaths.length > 0 || hasRecognition) {
            await supabaseAdmin
              .from("inv_skus")
              .update({
                ...(incomingPaths.length > 0
                  ? {
                      image_paths: merged,
                      // 兼容：旧 image_url 仍指向第 0 张外链（无外链则保持原值）
                      image_url:
                        merged.find((p) => /^https?:\/\//i.test(p)) ?? existSku.image_url ?? null,
                    }
                  : {}),
                ...recognitionFields,
                updated_at: new Date().toISOString(),
              } as never)
              .eq("id", skuId);
          }
        } else {
          skuCode = generateSkuCode(body.category, "single");
          epc = generateEpc(body.category, body.price_tier);
          const firstHttp = incomingPaths.find((p) => /^https?:\/\//i.test(p)) ?? null;
          const ins = await supabaseAdmin
            .from("inv_skus")
            .insert({
              category: body.category,
              name: body.name,
              price_tier: body.price_tier,
              is_custom_price: body.is_custom_price,
              inventory_policy: body.is_custom_price ? "tracked" : "unlimited",
              kind: "single",
              epc,
              sku_code: skuCode,
              image_paths: incomingPaths,
              image_url: firstHttp, // 仅在有外链时填，避免存过期 signed URL
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
              stock_qty: 0,
              status: "active",
            } as never)
            .select("id, sku_code, epc, barcode, grade")
            .single();
          if (ins.error || !ins.data) return err(`Create SKU failed: ${ins.error?.message}`, 500);
          skuId = ins.data.id;
          skuCode = ins.data.sku_code ?? skuCode;
          epc = ins.data.epc;
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

        // Bind extra EPCs (if APP scanned labels already)
        let boundCount = 0;
        for (const e of body.epcs ?? []) {
          const upsertEpc = await supabaseAdmin.from("inv_epcs").upsert(
            {
              epc: e,
              sku_id: skuId,
              status: "in_stock",
              current_location_id: locationId,
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "epc" },
          );
          if (!upsertEpc.error) boundCount++;
        }

        // +1 movement at the chosen location (and warehouse stock_qty if warehouse)
        const mv = await supabaseAdmin.rpc("inv_apply_movement", {
          p_sku_id: skuId,
          p_location_id: locationId,
          p_delta: 1 + boundCount,
          p_ref_type: "handheld_smart_create",
          p_epc: epc,
          p_note: `device:${auth.device.device_code}${session ? ` user:${session.email ?? session.user_id}` : ""}`,
        } as never);
        if (mv.error) return err(`Stock movement failed: ${mv.error.message}`, 500);

        // 有赞自动上架：门店库位必须走正式的门店商品发布链路，发布成功后再推库存。
        let syncStatus: "disabled" | "queued" | "linked" | "unlinked" | "hq_created" | "hq_failed" =
          "disabled";
        const releaseShopId = getSmartCreateReleaseTarget({
          autoPushYouzan: body.auto_push_youzan,
          locationKind: loc.kind,
          shopId: loc.shop_id,
        });
        if (releaseShopId) {
          try {
            const { releaseSkuToOfflineShopsCore } =
              await import("@/lib/youzan-offline-products.functions");
            const release = await releaseSkuToOfflineShopsCore({
              sku_id: skuId,
              shop_ids: [releaseShopId],
            });
            syncStatus = release.ok ? "queued" : "hq_failed";
          } catch (e) {
            console.error("[handheld smart-create] 门店自动上架失败", e);
            syncStatus = "hq_failed";
          }
        } else if (body.auto_push_youzan) {
          syncStatus = "unlinked";
        }

        const { data: finalSku } = await supabaseAdmin
          .from("inv_skus")
          .select("stock_qty, barcode, grade")
          .eq("id", skuId)
          .maybeSingle();

        const barcode = finalSku?.barcode ?? null;
        const conditionGrade = (finalSku?.grade ?? body.grade ?? null) as
          "N" | "S" | "A" | "B" | "C" | "J" | null;

        const responseBody = {
          sku_id: skuId,
          sku_code: skuCode,
          barcode,
          epc,
          condition_grade: conditionGrade,
          stock_qty: finalSku?.stock_qty ?? 0,
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
            qrcode_payload: `vg://sku/${skuId}`,
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
        };
        await recordOp({
          deviceId: auth.device.id,
          clientOpId: body.client_op_id,
          opType: "items.smart-create",
          status: 200,
          body: { ok: true, data: responseBody },
        });
        return ok(responseBody);
      },
    },
  },
});
