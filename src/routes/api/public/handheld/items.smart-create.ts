import { advanceListingReadiness } from "@/server/listing-readiness.server";
import { createServerTiming } from "@/lib/server-timing";
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
import { readProductMarks } from "@/lib/commerce/product-marks";

/** Marks only when the client sent them; omitted keys keep the legacy commit path unchanged. */
function smartCreateMarks(body: { featured_stamp?: unknown; notice_tags?: unknown }) {
  const marks: Record<string, unknown> = {};
  if (body.featured_stamp !== undefined) marks.featured_stamp = body.featured_stamp;
  if (body.notice_tags !== undefined) marks.notice_tags = body.notice_tags;
  return Object.keys(marks).length ? marks : null;
}
import { generateEpc, generateSkuCode } from "@/lib/inventory.helpers";
import { buildPrintPayload } from "@/server/handheld-print.server";
import { replayIfPresent, jsonReplay } from "@/server/handheld-idempotency.server";
import {
  getSmartCreateReleaseTarget,
  persistSmartCreateBrand,
  resolveConfirmedListingBrand,
  shouldReuseSmartCreateSku,
  smartCreateRequestFingerprint,
  type SmartCreateCommitResult,
} from "@/server/handheld-smart-create.server";
import {
  assertActiveLeafCategory,
  attachProductClassificationAuditToSku,
  replaceManualProductFacets,
  resolveIpCandidate,
  resolveOrCreateConfirmedIp,
  resolveManualProductFacets,
} from "@/server/product-classification.server";
import { dbConsentStore } from "@/server/ai-consent.server";
import { AI_POLICY_VERSION, smartCreateWantsAi } from "@/server/ai-consent-core";
import { triggerListingImageWorker } from "@/server/handheld-listing-image-jobs.server";

export const Route = createFileRoute("/api/public/handheld/items/smart-create")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const timing = createServerTiming();
        return timing.apply(await handleSmartCreate(request, timing));
      },
    },
  },
});

async function handleSmartCreate(request: Request, timing: ReturnType<typeof createServerTiming>): Promise<Response> {
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
        timing.mark("auth");

        const { fingerprint, incomingPaths } = smartCreateRequestFingerprint(body, locationId);
        let existingOp = false;
        if (body.client_op_id) {
          const prior = await supabaseAdmin.from("handheld_smart_create_ops")
            .select("user_id,location_id,payload_fingerprint,response_json,status")
            .eq("device_id", auth.device.id).eq("client_op_id", body.client_op_id).maybeSingle();
          if (prior.error) return err("Unable to check listing operation; retry with the same client_op_id", 503);
          existingOp = !!prior.data;
          if (prior.data) {
            if (prior.data.user_id !== session.user_id || prior.data.location_id !== locationId ||
                prior.data.payload_fingerprint !== fingerprint) {
              return err("client_op_id reused with a different payload, user or location", 409, { code: "client_op_id_conflict" });
            }
            if (prior.data.status === "cancelled") {
              return err("This listing operation was cancelled; start a new operation", 409, { code: "client_op_cancelled" });
            }
            if (prior.data.response_json) return jsonReplay({ response_status: 200, response_json: prior.data.response_json });
          } else {
            // Only old clients' historical operations use the legacy log; new writes never populate it.
            const replay = await replayIfPresent({ deviceId: auth.device.id, clientOpId: body.client_op_id, opType: "items.smart-create" });
            if (replay) return jsonReplay(replay);
          }
        }
        timing.mark("idempotency");
        // 只读校验并行（类目 / 标签 / 品牌 / 库位）；报错优先级与原串行顺序一致。
        const [catR, facetsR, brandR, locR] = await Promise.allSettled([
          assertActiveLeafCategory(body.category),
          body.facet_codes !== undefined || body.tags !== undefined
            ? resolveManualProductFacets({
                categoryCode: body.category,
                facetCodes: body.facet_codes,
                legacyTags: body.tags,
              })
            : Promise.resolve(null),
          resolveConfirmedListingBrand(body),
          supabaseAdmin
            .from("inv_locations")
            .select("id, name, kind, shop_id, is_active")
            .eq("id", locationId)
            .maybeSingle(),
        ]);
        if (catR.status === "rejected")
          return err((catR.reason as Error).message, existingOp ? 500 : 422, { code: "validation_error" });
        if (facetsR.status === "rejected")
          return err((facetsR.reason as Error).message, existingOp ? 500 : 422, { code: "validation_error" });
        if (brandR.status === "rejected")
          return err((brandR.reason as Error).message, existingOp ? 500 : 422, { code: "brand_confirmation_required" });
        const manualFacets = facetsR.value;
        const confirmedBrand = brandR.value;
        // IP 可能新建记录，保持在只读校验全部通过之后串行执行。
        let resolvedIp: { id: string | null; name: string | null; status: "empty" | "matched" | "review" };
        const ipCandidate = body.ip_candidate;
        if (ipCandidate !== undefined && (body.ip_confirmed || (body.ip_name ?? "").trim())) {
          return err("待核对 IP 不能与已填写或已确认的 IP 同时提交，请只保留一种", 400, { code: "validation_error" });
        }
        try {
          resolvedIp = ipCandidate !== undefined
            ? await resolveIpCandidate(ipCandidate)
            : await resolveOrCreateConfirmedIp({
                name: body.ip_name,
                confirmed: body.ip_confirmed,
              });
        } catch (e) {
          return err((e as Error).message, existingOp ? 500 : 422, { code: "ip_confirmation_required" });
        }
        if (locR.status === "rejected") throw locR.reason;
        const loc = locR.value.data;
        timing.mark("validate");
        if (!loc || !loc.is_active) return err("Location not found or disabled", 404);

        const hasRecognition = !!body.recognition_request_id;
        const releaseShopId = getSmartCreateReleaseTarget({
          autoPushYouzan: body.auto_push_youzan,
          locationKind: loc.kind,
          shopId: loc.shop_id,
        });

        // 图片计划在提交前决定，并随建品同一事务持久化（含可信员工与政策版本）；ai 计划的图片任务同事务入队。
        // 只有客户端明确不做 AI 或员工授权记录明确为 false 才走原图；授权未明确/读取失败 → pending_consent，由 worker 补决。
        let aiProcessing: "queued_or_idle" | "skipped_by_client" | "consent_required" | "consent_unavailable" =
          "queued_or_idle";
        let imagePlan: "ai" | "raw_declined" | "pending_consent";
        if (!smartCreateWantsAi(body.ai_processing_allowed)) {
          aiProcessing = "skipped_by_client";
          imagePlan = "raw_declined";
        } else {
          try {
            const stored = await dbConsentStore().get(session.user_id, AI_POLICY_VERSION);
            if (stored === true) imagePlan = "ai";
            else if (stored === false) { aiProcessing = "consent_required"; imagePlan = "raw_declined"; }
            else { aiProcessing = "consent_required"; imagePlan = "pending_consent"; }
          } catch {
            aiProcessing = "consent_unavailable";
            imagePlan = "pending_consent";
          }
        }

        // SKU 建档 + EPC 绑定 + 一次入库 + 有赞发布 outbox + 幂等行：同一数据库事务。
        // 同 (device, client_op_id) 重试只得到原 SKU；user / location / 载荷不同返回 409。
        const firstHttp = incomingPaths.find((p) => /^https?:\/\//i.test(p)) ?? null;
        timing.mark("pre_commit");
        const commit = await supabaseAdmin.rpc("handheld_smart_create_commit_v3" as never, {
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
            // 标准商品不参与翻筐乐：忽略客户端值；省略/null 表示按售价自动。
            fankuang_override: body.is_custom_price ? (body.fankuang_override ?? null) : null,
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
          p_image_plan: imagePlan,
          p_ai_policy: AI_POLICY_VERSION,
          p_marks: smartCreateMarks(body),
        } as never);
        if (commit.error) {
          if ((commit.error as { code?: string }).code === "P0410")
            return err("This listing operation was cancelled; start a new operation", 409, { code: "client_op_cancelled" });
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
        // 照片（含标准品复用追加）全部由建品事务 handheld_smart_create_commit_v2 写入并按本次员工计划入队；
        // 提交后绝不再写 image_paths，避免 worker 已处理的原图被复活。这里只补识别属性。
        if (hasRecognition) {
          const upd = await supabaseAdmin
            .from("inv_skus")
            .update({
              attributes: body.attributes,
              category_source: "ai",
              category_confidence: body.category_confidence ?? null,
              classification_status: body.classification_status ?? "fallback",
              ai_suggested_price: body.ai_suggested_price ?? null,
              recognition_request_id: body.recognition_request_id,
              updated_at: new Date().toISOString(),
            } as never)
            .eq("id", skuId);
          if (upd.error) return err(`Save SKU attributes failed: ${upd.error.message}`, 500);
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
          await persistSmartCreateBrand({ skuId, brand: body.brand, confirmedBrand });
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

        const openJobs = Number((committed as { image_jobs_open?: number }).image_jobs_open ?? 0);
        const imageProcessing: { status: "idle" | "queued"; queued: number } =
          openJobs > 0 ? { status: "queued", queued: openJobs } : { status: "idle", queued: 0 };
        // 图片计划/任务已在建品事务内持久化；这里只推进一次准备状态（失败由 worker 完成回调与 sweep 继续推进）。
        try {
          await advanceListingReadiness(skuId);
        } catch (e) {
          console.error("[handheld smart-create] 上架准备推进失败", (e as Error).message);
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
        let storefrontStatus: "skipped" | "published" | "processing" | "sold" | "failed" = "skipped";
        const { data: storefrontListing, error: storefrontError } = await supabaseAdmin
          .from("commerce_listings")
          .select("id, status, readiness_hold")
          .eq("sku_id", skuId)
          .eq("location_id", locationId)
          .maybeSingle();
        if (storefrontError) {
          storefrontStatus = "failed";
          console.error("[handheld smart-create] 读取市集上架结果失败", storefrontError);
        } else if (storefrontListing) {
          storefrontListingId = storefrontListing.id;
          storefrontStatus =
            storefrontListing.status === "published"
              ? "published"
              : (storefrontListing as { readiness_hold?: boolean }).readiness_hold
                ? "processing"
                : "sold";
        }

        const { data: finalSku, error: finalSkuError } = await supabaseAdmin
          .from("inv_skus")
          .select("stock_qty, barcode, grade, featured_stamp, notice_tags")
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
          ai_processing: aiProcessing === "queued_or_idle" ? "allowed" : aiProcessing,
          storefront_listing_id: storefrontListingId,
          storefront_status: storefrontStatus,
          ...readProductMarks(finalSku as { featured_stamp?: unknown; notice_tags?: unknown } | null),
          ...(ipCandidate !== undefined ? { ip_review_pending: resolvedIp.status === "review" } : {}),
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
        timing.mark("finalize");
        return ok(responseBody);
}

