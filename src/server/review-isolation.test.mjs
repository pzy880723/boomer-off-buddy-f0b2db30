// node --test src/server/review-isolation.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  REVIEW_TOKEN_PREFIX, assertNoExternalWrite, assertReviewIsolation, genReviewDeviceToken,
  isReviewIsolated, reviewIsolationViolations,
} from "./review-isolation.mjs";

const SAFE = {
  BOOMER_REVIEW_ISOLATED: "true",
  SUPABASE_URL: "https://review-demo.example.invalid",
  VITE_SUPABASE_URL: "https://review-demo.example.invalid",
  SUPABASE_PUBLISHABLE_KEY: "demo-publishable",
  SUPABASE_SERVICE_ROLE_KEY: "demo-service",
};

test("production (flag off) is unaffected even with real channels", () => {
  const env = { SUPABASE_URL: "https://sxddfcoiaboqcmeviykl.supabase.co", YOUZAN_CLIENT_ID: "x" };
  assert.equal(isReviewIsolated(env), false);
  assert.deepEqual(reviewIsolationViolations(env), []);
  assert.doesNotThrow(() => assertNoExternalWrite("youzan", env));
});

test("safe demo config passes", () => assert.deepEqual(reviewIsolationViolations(SAFE), []));

test("demo refuses production database, missing keys, real channels and workers", () => {
  const v = reviewIsolationViolations({
    BOOMER_REVIEW_ISOLATED: "true",
    SUPABASE_URL: "https://sxddfcoiaboqcmeviykl.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "k",
    YOUZAN_CLIENT_ID: "x", WECHAT_PAY_MCHID: "1", TENCENT_SMS_SDK_APP_ID: "1",
    YOUZAN_STOCK_WORKER_ENABLED: "true", STOREFRONT_PAYMENT_MODE: "live",
  });
  for (const c of ["production_data:SUPABASE_URL", "missing:SUPABASE_SERVICE_ROLE_KEY",
    "external_channel:YOUZAN_CLIENT_ID", "external_channel:WECHAT_PAY_MCHID",
    "external_channel:TENCENT_SMS_SDK_APP_ID", "worker_enabled:YOUZAN_STOCK_WORKER_ENABLED",
    "external_channel:STOREFRONT_PAYMENT_MODE"]) assert.ok(v.includes(c), c);
  assert.ok(!v.join(",").includes("sxddf") || v.every((x) => !x.includes("supabase.co")), "never echoes values");
  assert.throws(() => assertReviewIsolation({ ...SAFE, SUPABASE_URL: "https://data.boomeroff.top" }),
    (e) => e.code === "review_isolation_violation");
});

test("demo blocks every real external write path", () => {
  for (const ch of ["youzan", "sms", "wechat_pay"])
    assert.throws(() => assertNoExternalWrite(ch, SAFE), (e) => e.code === "review_isolation_violation");
});

test("demo device tokens carry rvw_ prefix and are random", () => {
  const a = genReviewDeviceToken(), b = genReviewDeviceToken();
  assert.ok(a.startsWith(REVIEW_TOKEN_PREFIX) && a.length === 44 && a !== b);
});

test("bootstrap: production token path unchanged, demo path gated and marked", () => {
  const src = readFileSync("src/routes/api/public/handheld/auth.bootstrap.ts", "utf8");
  assert.match(src, /demo \? genReviewDeviceToken\(\) : genToken\(\)/);
  assert.match(src, /\.\.\.\(demo \? \{ environment: REVIEW_ENVIRONMENT \} : \{\}\)/);
  assert.match(src, /review_isolation_violation/);
  const sh = readFileSync("scripts/run-tencent-erp.sh", "utf8");
  assert.match(sh, /assert-review-isolation\.mjs/);
  for (const f of ["src/lib/youzan-http.ts", "src/server/sms.tencent.server.ts", "src/server/wechat-ordinary-client.ts"])
    assert.match(readFileSync(f, "utf8"), /assertNoExternalWrite\(/, f);
  assert.match(readFileSync("src/server/pos-payment-provider.server.ts", "utf8"), /review_isolated/);
});

// Columns captured read-only from the live schema on 2026-10-09 ("!" = NOT NULL without default).
const SCHEMA = {
  inv_locations: "id kind! name! shop_id is_active notes created_at updated_at",
  user_roles: "id user_id! role! created_at",
  user_location_perms: "user_id! location_id! created_at",
  inv_categories: "id code! name! parent_id sort_order is_active is_system youzan_hq_category_id created_at updated_at youzan_hq_parent_id kind shipping_fragile",
  inv_skus: "id category! price_tier! name! kind pack_pieces epc! weight_g image_url stock_qty notes status created_at updated_at is_custom_price sku_code bundle_items grade barcode image_paths is_display default_shop_ids sku_scope sales_state inventory_version attributes category_source category_confidence classification_status ai_suggested_price recognition_request_id brand_id brand_candidate_text keywords attribute_confidence clarification_requests sale_ownership discount_eligible settlement_party_ref inventory_policy ip_id ip_candidate_text image_processing_status image_processing_updated_at fankuang_override",
  inv_stocks: "sku_id! location_id! qty updated_at",
  commerce_orders: "id order_no user_id payment_status order_status currency subtotal shipping_fee discount_total total_amount recipient_name recipient_phone shipping_address courier_provider courier_service_code courier_service_name courier_quote_snapshot customer_note idempotency_key! reservation_expires_at! provider_transaction_id paid_at cancelled_at completed_at created_at updated_at source_channel fulfillment_method sale_location_id operator_id customer_id metadata pos_shift_id discount_snapshot benefit_snapshot authorization_id payment_route",
  commerce_order_items: "id order_id! listing_id sku_id! location_id! epc title_snapshot! image_snapshot condition_snapshot unit_price! quantity line_total! created_at original_unit_price discount_total discount_snapshot ownership_snapshot settlement_subject_id settlement_snapshot category_code category_name_snapshot subcategory_code subcategory_name_snapshot brand_id brand_name_snapshot character_id character_name_snapshot",
  support_agents: "id user_id! scope location_id display_name is_active created_at updated_at",
  support_conversations: "id title location_id customer_id order_id topic status last_message_at last_message_preview created_at updated_at context_key context channel primary_agent_id assignment_version escalated_at escalation_reason waiting_since",
  support_participants: "id conversation_id! user_id! participant_role display_name joined_at last_read_at",
  support_messages: "id conversation_id! sender_type! sender_user_id sender_customer_id sender_name! body! internal client_op_id created_at delivery_status assignment_version",
};

test("seed: every insert column exists, required columns covered, demo-labelled, guarded", () => {
  const sql = readFileSync("deployments/appstore-review-demo-20261009/seed.sql", "utf8");
  const inserts = [...sql.matchAll(/INSERT INTO public\.(\w+) \(([^)]+)\)/g)];
  assert.equal(new Set(inserts.map((m) => m[1])).size, Object.keys(SCHEMA).length);
  for (const [, table, cols] of inserts) {
    const spec = SCHEMA[table].split(" ");
    const known = spec.map((c) => c.replace("!", ""));
    const used = cols.split(",").map((c) => c.trim());
    for (const c of used) assert.ok(known.includes(c), `${table}.${c} not in schema`);
    for (const r of spec.filter((c) => c.endsWith("!"))) assert.ok(used.includes(r.slice(0, -1)), `${table} missing ${r}`);
  }
  assert.match(sql, /contains non-demo data; refusing/);
  assert.match(sql, /must already exist in THIS instance Auth/);
  assert.doesNotMatch(sql, /sxddfcoiaboqcmeviykl|boomeroff\.top|supabase\.co|https?:\/\//);
  for (const m of sql.matchAll(/'([^']*[\u4e00-\u9fa5][^']*)'/g))
    if (!/^(演示|【演示】)/.test(m[1]) && !m[1].includes("演示")) assert.fail(`non-demo label: ${m[1]}`);
  assert.doesNotMatch(sql, /image_url|image_paths|phone/);
});
