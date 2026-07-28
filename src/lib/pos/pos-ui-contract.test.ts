import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const routesRoot = new URL("../../routes/", import.meta.url);

describe("POS UI contract", () => {
  test("provides a full-screen POS route with the complete cashier flow", () => {
    const routeUrl = new URL("pos.tsx", routesRoot);
    assert.equal(existsSync(routeUrl), true);
    const source = readFileSync(routeUrl, "utf8");
    for (const capability of ["开班", "扫码", "商品浏览", "购物车", "收款", "打印小票", "交班"]) {
      assert.match(source, new RegExp(capability));
    }
    assert.match(source, /\/api\/public\/pos\/bootstrap/);
    assert.match(source, /\/api\/public\/pos\/products\?/);
    assert.match(source, /\/api\/public\/pos\/products\/lookup/);
    assert.match(source, /\/api\/public\/pos\/sales/);
    assert.match(source, /\/receipt/);
    for (const capability of ["识别会员", "整单优惠", "挂单", "组合支付", "订单退换", "电子小票"]) {
      assert.match(source, new RegExp(capability));
    }
    assert.doesNotMatch(source, /挂单功能即将接入/);
  });

  test("registers POS as a full-screen navigation destination", () => {
    const rootSource = readFileSync(new URL("__root.tsx", routesRoot), "utf8");
    const sidebarSource = readFileSync(
      new URL("../../components/app-sidebar.tsx", import.meta.url),
      "utf8",
    );
    assert.match(rootSource, /pathname\.startsWith\("\/pos"\)/);
    assert.match(sidebarSource, /"\/pos"/);
    assert.match(sidebarSource, /门店收银/);
  });
});
