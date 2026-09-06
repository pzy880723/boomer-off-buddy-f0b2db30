import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_STATUS_FILTERS,
  FULFILLMENT_STATUS_FILTERS,
  FULFILLMENT_STATUS_LABELS,
  clampPage,
  clampPageSize,
  maskName,
  maskPhone,
  buildAddressSummary,
  deriveOrderStatus,
  orderStatusLabel,
  toAmount,
} from "@/server/handheld-orders.server";

describe("订单列表契约", () => {
  test("状态枚举与 App 契约一致", () => {
    assert.deepEqual(ORDER_STATUS_FILTERS, [
      "all",
      "pending",
      "unpaid",
      "after_sales",
      "shipped",
      "completed",
      "cancelled",
    ]);
    assert.deepEqual(FULFILLMENT_STATUS_FILTERS, [
      "all",
      "pending_customer",
      "allocated",
      "picking",
      "picked",
      "handover_ready",
      "handed_over",
      "cancelled",
    ]);
    assert.equal(FULFILLMENT_STATUS_LABELS.handover_ready, "待取件");
  });

  test("分页参数被服务端夹紧", () => {
    assert.equal(clampPage(null), 1);
    assert.equal(clampPage("0"), 1);
    assert.equal(clampPage("abc"), 1);
    assert.equal(clampPage("3"), 3);
    assert.equal(clampPageSize(null), 20);
    assert.equal(clampPageSize("500"), 100);
    assert.equal(clampPageSize("0"), 1);
    assert.equal(clampPageSize("35"), 35);
  });

  test("姓名/手机号脱敏", () => {
    assert.equal(maskName("张三"), "张*");
    assert.equal(maskName("王小明"), "王*明");
    assert.equal(maskName(null), null);
    assert.equal(maskPhone("13812345678"), "138****5678");
    assert.equal(maskPhone(null), null);
  });

  test("地址摘要保留省市区但遮蔽门牌", () => {
    const summary = buildAddressSummary({
      province: "浙江省",
      city: "温州市",
      district: "鹿城区",
      detail: "朔门古港街道12号3单元501",
    });
    assert.ok(summary?.startsWith("浙江省温州市鹿城区"));
    assert.ok(summary?.includes("*"));
    assert.ok(!summary?.includes("501"));
    assert.equal(buildAddressSummary(null), null);
  });

  test("订单状态派生与实付金额规则", () => {
    assert.equal(
      deriveOrderStatus({
        payment_status: "unpaid",
        order_status: "pending_payment",
        has_handed_over: false,
      }),
      "unpaid",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "paid",
        order_status: "processing",
        has_handed_over: false,
      }),
      "pending",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "paid",
        order_status: "processing",
        has_handed_over: true,
      }),
      "shipped",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "paid",
        order_status: "after_sale",
        has_handed_over: true,
      }),
      "after_sales",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "unpaid",
        order_status: "cancelled",
        has_handed_over: false,
      }),
      "cancelled",
    );
    assert.equal(orderStatusLabel("shipped"), "已发出");
    assert.equal(toAmount("12.905"), 12.9);
    assert.equal(toAmount(null), 0);
  });
});
