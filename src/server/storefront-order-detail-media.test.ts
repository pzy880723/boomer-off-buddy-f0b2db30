import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withOrderItemThumbnails } from "./storefront-order-detail-media.server";

const order = {
  id: "o1",
  order_no: "BO1",
  total_amount: 12.3,
  payment_status: "paid",
  items: [
    { id: "i1", image_snapshot: "sku-listing/a.jpg", unit_price: 1, quantity: 2 },
    { id: "i2", image_snapshot: "https://cdn.example.com/legacy.jpg", unit_price: 3, quantity: 1 },
    { id: "i3", image_snapshot: null, unit_price: 4, quantity: 1 },
  ],
};

describe("order detail media", () => {
  test("image_snapshot 换成衍生图，未支持来源为 null，其他字段不变", async () => {
    const seen: string[][] = [];
    const out = await withOrderItemThumbnails(order, async (values) => {
      seen.push([...values]);
      return values.map((v) => (v.startsWith("sku-listing/") ? `https://thumb/480/${v}` : null));
    });
    assert.deepEqual(seen[0], ["sku-listing/a.jpg", "https://cdn.example.com/legacy.jpg", ""]);
    assert.deepEqual(
      out.items.map((item) => item.image_snapshot),
      ["https://thumb/480/sku-listing/a.jpg", null, null],
    );
    assert.equal(out.total_amount, 12.3);
    assert.equal(out.payment_status, "paid");
    assert.equal(out.items[0].quantity, 2);
  });

  test("签名整体失败时全部 null，绝不回退原图", async () => {
    const out = await withOrderItemThumbnails(order, async () => {
      throw new Error("transform down");
    });
    assert.deepEqual(
      out.items.map((item) => item.image_snapshot),
      [null, null, null],
    );
  });

  test("无 items 的订单原样返回", async () => {
    const bare = { id: "o2", items: [] };
    assert.equal(
      await withOrderItemThumbnails(bare, async () => {
        throw new Error("must not be called");
      }),
      bare,
    );
  });
});
