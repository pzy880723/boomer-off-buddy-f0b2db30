import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const srcRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationsRoot = fileURLToPath(
  new URL("../../../supabase/migrations/", import.meta.url),
);
const migrations = readdirSync(migrationsRoot)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(migrationsRoot, name), "utf8"))
  .join("\n");

describe("commerce operations administration", () => {
  test("adds real online order and after-sale routes", () => {
    const onlineRoute = join(srcRoot, "routes/orders.online.tsx");
    const afterSalesRoute = join(srcRoot, "routes/orders.after-sales.tsx");
    assert.equal(existsSync(onlineRoute), true);
    assert.equal(existsSync(afterSalesRoute), true);
    assert.match(readFileSync(onlineRoute, "utf8"), /listCommerceOrders/);
    assert.match(readFileSync(afterSalesRoute, "utf8"), /listCommerceAfterSales/);
  });

  test("shows both entries in ERP order navigation", () => {
    const sidebar = readFileSync(join(srcRoot, "components/app-sidebar.tsx"), "utf8");
    assert.match(sidebar, /网店订单/);
    assert.match(sidebar, /售后订单/);
  });

  test("after-sales are assigned to the source store and order item", () => {
    assert.match(migrations, /CREATE TABLE public\.commerce_after_sales/);
    assert.match(migrations, /order_item_id uuid NOT NULL/);
    assert.match(migrations, /location_id uuid NOT NULL/);
    assert.match(migrations, /uniq_active_commerce_after_sale_item/);
  });
});
