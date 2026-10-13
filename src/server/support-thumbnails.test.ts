import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConversationThumbnails } from "./support-thumbnails.server.ts";

// Fake query client: records each table query, applies .eq/.in filters on fixture rows.
function fakeClient(tables: Record<string, any[]>) {
  const log: { table: string; filters: string[] }[] = [];
  return {
    log,
    from(table: string) {
      const entry = { table, filters: [] as string[] };
      log.push(entry);
      let rows = [...(tables[table] ?? [])];
      const q: any = {
        select() { return q; },
        eq(col: string, v: unknown) { entry.filters.push(`eq:${col}`); rows = rows.filter((r) => r[col] === v); return q; },
        in(col: string, vs: unknown[]) { entry.filters.push(`in:${col}`); rows = rows.filter((r) => vs.includes(r[col])); return q; },
        order() { return q; },
        then(res: any, rej: any) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}
const SIGNED = "https://media.example/storage/v1/render/image/sign/";
const sign = async (paths: readonly string[]) => paths.map((p) => (p.includes("broken") ? null : `${SIGNED}${p}?width=480`));

const tables = {
  commerce_listings: [
    { id: "L1", image_paths: ["sku-listing/kitty.jpg", "sku-listing/b.jpg"], cover_url: null },
    { id: "L2", image_paths: [], cover_url: null },
  ],
  commerce_orders: [
    { id: "O1", customer_id: "me" },
    { id: "O2", customer_id: "me" },
    { id: "OX", customer_id: "someone-else" },
  ],
  commerce_order_items: [
    { id: "i1", order_id: "O1", created_at: "1", image_snapshot: "sku-listing/broken.jpg", listing: null, sku: null },
    { id: "i2", order_id: "O1", created_at: "2", image_snapshot: null, listing: { image_paths: ["sku-listing/second.jpg"], cover_url: null }, sku: null },
    { id: "i3", order_id: "O1", created_at: "3", image_snapshot: "sku-listing/third.jpg", listing: null, sku: null },
    { id: "i4", order_id: "O2", created_at: "1", image_snapshot: "data:image/png;base64,AAA", listing: null, sku: null },
    { id: "ix", order_id: "OX", created_at: "1", image_snapshot: "sku-listing/foreign.jpg", listing: null, sku: null },
  ],
};

const rows = [
  { id: "c-prod", location_id: "S", order_id: null, context: { type: "product", id: "L1" } },
  { id: "c-prod-noimg", location_id: "S", order_id: null, context: { type: "product", id: "L2" } },
  { id: "c-order", location_id: "S", order_id: "O1", context: { type: "order", id: "O1" } },
  { id: "c-order-noimg", location_id: "S", order_id: "O2", context: { type: "order", id: "O2" } },
  { id: "c-forged", location_id: null, order_id: null, context: { type: "order", id: "OX" } },
  { id: "c-hq", location_id: null, order_id: null, context: null },
  { id: "c-raw", location_id: null, order_id: null, context: { type: "product", id: "L1", image_url: "https://raw/original.jpg" } },
];

test("thumbnails: product first image, order first signable item, null for HQ/no image/forged order", async () => {
  const client = fakeClient(tables);
  const map = await loadConversationThumbnails(rows, "me", { client, sign });
  assert.equal(map.get("c-prod"), `${SIGNED}sku-listing/kitty.jpg?width=480`);
  assert.equal(map.get("c-prod-noimg"), null);
  assert.equal(map.get("c-order"), `${SIGNED}sku-listing/second.jpg?width=480`, "broken first item skipped");
  assert.equal(map.get("c-order-noimg"), null, "data: snapshot never shown");
  assert.equal(map.get("c-forged"), null, "other customer's order not resolved");
  assert.equal(map.get("c-hq"), null);
  assert.equal(map.get("c-raw"), `${SIGNED}sku-listing/kitty.jpg?width=480`, "context image_url ignored");
  const all = JSON.stringify([...map.values()]);
  assert.ok(!all.includes("foreign.jpg") && !all.includes("raw/original"));
  // Query count: exactly one listing, one order (owner-filtered), one order-item batch.
  assert.deepEqual(client.log.map((l) => l.table), ["commerce_listings", "commerce_orders", "commerce_order_items"]);
  assert.ok(client.log[1].filters.includes("eq:customer_id"));
  assert.ok(!client.log[2].filters.join().includes("OX") );
});

test("only derivative URLs are returned; unsigned/original values become null", async () => {
  const client = fakeClient(tables);
  const map = await loadConversationThumbnails(rows, "me", { client, sign: async (p) => p.map(() => null) });
  assert.ok([...map.values()].every((v) => v === null));
});

test("empty input issues no queries", async () => {
  const client = fakeClient(tables);
  const map = await loadConversationThumbnails([{ id: "c", location_id: null, order_id: null, context: null }], "me", { client, sign });
  assert.equal(map.get("c"), null);
  assert.equal(client.log.length, 0);
});

test("list DTO whitelists top-level thumbnail_url and server wires the batch loader", () => {
  const dto = readFileSync(new URL("../lib/support-customer-dto.ts", import.meta.url), "utf8");
  assert.match(dto, /"thumbnail_url"/);
  const src = readFileSync(new URL("./support.server.ts", import.meta.url), "utf8");
  const list = src.slice(src.indexOf("export async function listCustomerConversations"), src.indexOf("async function loadCustomerLocationNames"));
  assert.match(list, /loadConversationThumbnails\(rows, customerId/);
});
