import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const routesRoot = new URL("../../routes/", import.meta.url);

describe("POS UI contract", () => {
  test("provides a full-screen POS route with the complete cashier flow", () => {
    const routeUrl = new URL("pos.tsx", routesRoot);
    assert.equal(existsSync(routeUrl), true);
    const source = readFileSync(routeUrl, "utf8");
    for (const capability of ["扫码", "商品浏览", "购物车", "收款", "打印小票", "钱箱"]) {
      assert.match(source, new RegExp(capability));
    }
    assert.doesNotMatch(source, /开班备用金|确认开班|确认交班/);
    assert.match(source, /\/api\/public\/pos\/bootstrap/);
    assert.match(source, /\/api\/public\/pos\/shifts\/open/);
    assert.match(source, /\/api\/public\/pos\/cash-movements/);
    assert.match(source, /\/api\/public\/pos\/products\?/);
    assert.match(source, /\/api\/public\/pos\/products\/lookup/);
    assert.match(source, /\/api\/public\/pos\/sales/);
    assert.match(source, /\/receipt/);
    for (const capability of ["识别会员", "整单优惠", "挂单", "组合支付", "订单退换", "电子小票"]) {
      assert.match(source, new RegExp(capability));
    }
    assert.doesNotMatch(source, /挂单功能即将接入/);
  });

  test("keeps the cashier checkout panel in a three-row layout with a single scroll area", () => {
    const source = readFileSync(new URL("pos.tsx", routesRoot), "utf8");
    // 右栏三个稳定钩子
    assert.match(source, /data-pos-checkout-panel/);
    assert.match(source, /data-pos-cart-scroll/);
    assert.match(source, /data-pos-settlement-footer/);
    // header / 弹性购物车 / 固定结算底栏
    assert.match(source, /grid-rows-\[auto_minmax\(0,1fr\)_auto\]/);
    // 桌面右栏宽度
    assert.match(source, /clamp\(420px,30vw,500px\)/);
    // 优惠 / 取单 / 挂单 / 退换 同一行
    assert.match(source, /grid-cols-4/);
    // 购物车不再限制 36vh，滚动交给右栏唯一滚动区
    assert.doesNotMatch(source, /max-h-\[36vh\]/);
    // 业务逻辑不得被布局改动带走
    assert.match(source, /posCartLineKey/);
    assert.match(source, /posCartLineLabel/);
    assert.match(source, /loadReceipt/);
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
