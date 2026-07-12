import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildYouzanQuantityUpdateParams,
  selectTrustedBranchItemIds,
} from "./youzan-quantity.server";

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
