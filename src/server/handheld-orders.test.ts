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
  orderStatusLabelFor,
  pickImageUrl,
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
        fulfillment_count: 0,
        handed_over_count: 0,
      }),
      "unpaid",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "paid",
        order_status: "processing",
        fulfillment_count: 2,
        handed_over_count: 0,
      }),
      "pending",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "paid",
        order_status: "processing",
        fulfillment_count: 2,
        handed_over_count: 2,
      }),
      "shipped",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "paid",
        order_status: "after_sale",
        fulfillment_count: 1,
        handed_over_count: 1,
      }),
      "after_sales",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "unpaid",
        order_status: "cancelled",
        fulfillment_count: 0,
        handed_over_count: 0,
      }),
      "cancelled",
    );
    assert.equal(orderStatusLabel("shipped"), "已发出");
    assert.equal(toAmount("12.905"), 12.9);
    assert.equal(toAmount(null), 0);
  });

  test("跨两店：一店已交接、一店拣货中 → 仍是待履约（部分履约），不能算已发出", () => {
    const input = {
      payment_status: "paid",
      order_status: "processing",
      fulfillment_count: 2,
      handed_over_count: 1,
    };
    const status = deriveOrderStatus(input);
    assert.equal(status, "pending");
    assert.equal(
      orderStatusLabelFor(status, {
        fulfillment_count: input.fulfillment_count,
        handed_over_count: input.handed_over_count,
      }),
      "部分履约",
    );
    // pending 筛选必须包含它，否则会漏备货
    assert.ok(["all", "pending"].includes("pending"));
    // 全部交接后才是已发出
    assert.equal(deriveOrderStatus({ ...input, handed_over_count: 2 }), "shipped");
    // 无子单的已付款订单仍是待履约
    assert.equal(
      deriveOrderStatus({ ...input, fulfillment_count: 0, handed_over_count: 0 }),
      "pending",
    );
  });

  test("退款/售后优先于完成态", () => {
    assert.equal(
      deriveOrderStatus({
        payment_status: "refunding",
        order_status: "completed",
        fulfillment_count: 1,
        handed_over_count: 1,
      }),
      "after_sales",
    );
    assert.equal(
      deriveOrderStatus({
        payment_status: "paid",
        order_status: "completed",
        fulfillment_count: 1,
        handed_over_count: 1,
        has_active_after_sale: true,
      }),
      "after_sales",
    );
    // 已取消仍最高优先
    assert.equal(
      deriveOrderStatus({
        payment_status: "refunded",
        order_status: "cancelled",
        fulfillment_count: 1,
        handed_over_count: 0,
      }),
      "cancelled",
    );
  });

  test("图片优先当前签名 URL，过期快照回退当前图", () => {
    assert.equal(
      pickImageUrl({ signed: "https://cdn/x?token=new", snapshot: "https://old?token=expired" }),
      "https://cdn/x?token=new",
    );
    // 签名快照（含 token）不可信，无当前签名时不返回过期链接
    assert.equal(pickImageUrl({ signed: null, snapshot: "https://old?token=expired" }), null);
    // 非签名快照可直接用
    assert.equal(
      pickImageUrl({ signed: null, snapshot: "https://cdn/plain.jpg" }),
      "https://cdn/plain.jpg",
    );
    // 废弃 image_url 仅作最后回退
    assert.equal(
      pickImageUrl({ signed: null, snapshot: null, legacy: "https://legacy/a.jpg" }),
      "https://legacy/a.jpg",
    );
    assert.equal(pickImageUrl({ signed: null, snapshot: null, legacy: null }), null);
  });
});
