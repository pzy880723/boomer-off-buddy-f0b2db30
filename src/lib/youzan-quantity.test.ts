import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildYouzanQuantityUpdateParams,
  selectTrustedBranchItemIds,
  assertYouzanStockWriteSucceeded,
  buildWarehouseStockAdjustment,
} from "./youzan-quantity.server";

test("a successful gateway envelope is not proof that stock changed", () => {
  assert.throws(() => assertYouzanStockWriteSucceeded({ success: false, message: "开启了进出存单据管理库存，修改库存不会生效" }), /进出存/);
  assert.throws(() => assertYouzanStockWriteSucceeded(false), /未生效/);
  assert.doesNotThrow(() => assertYouzanStockWriteSucceeded({ success: true }));
});

test("document-managed stock is an absolute scoped quantity, never an increment", () => {
  const params = buildWarehouseStockAdjustment({ warehouseCode: "MD00003", skuCode: "BM528690012347", quantity: 1, operationId: "ERPtest", createTime: "2026-09-24 12:00:00" });
  assert.equal(params.warehouse_code, "MD00003");
  assert.deepEqual(params.order_items, [{ sku_code: "BM528690012347", quantity: "1" }]);
  assert.equal("operate_type" in params, false);
  assert.throws(() => buildWarehouseStockAdjustment({ warehouseCode: "", skuCode: "x", quantity: 1, operationId: "x", createTime: "x" }));
});

test("quantity update sends the gateway param object expected by Youzan", () => {
  const params = buildYouzanQuantityUpdateParams({
    kdtId: 187395218,
    itemId: 4870205046,
    skuId: 15039602491,
    quantity: 1,
    channel: 1,
  });

  assert.deepEqual(params, {
    param: {
      kdtId: 187395218,
      kdt_id: 187395218,
      item_id: 4870205046,
      sku_id: 15039602491,
      channel: 1,
      stock_num: 1,
    },
  });
  assert.equal("kdt_id" in params, false);
});

test("existing branch ids are trusted when they differ from the HQ SPU id", () => {
  assert.deepEqual(
    selectTrustedBranchItemIds({
      linkItemId: 4870205046,
      linkSkuId: 15039602491,
      hqSpuId: 6060477331,
    }),
    { item_id: 4870205046, sku_id: 15039602491 },
  );
});

test("HQ ids stored in a branch link are rejected", () => {
  assert.equal(
    selectTrustedBranchItemIds({
      linkItemId: 6060477331,
      linkSkuId: 6060477331,
      hqSpuId: 6060477331,
    }),
    null,
  );
});

test("stock worker failures only mark the current shop link as failed", () => {
  const source = readFileSync(
    new URL("./youzan-sync.functions.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /\.eq\("sku_id", t\.sku_id\)\s*\.eq\("shop_id", t\.shop_id\)/,
  );
});
