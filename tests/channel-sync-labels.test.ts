import test from "node:test";
import assert from "node:assert/strict";
import { productDisplay, saleEventLabel, syncActionLabel, syncChannelLabel, syncStatusLabel, outboxNextAction } from "../src/lib/sync-record-labels.ts";

test("状态/动作/渠道/事件中文，未知值待核对不透传", () => {
  assert.equal(syncStatusLabel("failed"), "失败待处理");
  assert.equal(syncStatusLabel("dead_letter"), "多次失败已停止");
  assert.equal(syncStatusLabel("unmatched"), "未匹配商品");
  assert.equal(syncActionLabel("set_stock_zero"), "库存归零");
  assert.equal(syncChannelLabel("youzan_offline"), "有赞门店");
  assert.equal(saleEventLabel("paid"), "已支付");
  for (const f of [syncStatusLabel, syncActionLabel, syncChannelLabel, saleEventLabel]) {
    assert.equal(f("zz_secret_x"), "待核对");
    assert.equal(f(null), "待核对");
  }
});

test("商品主文案只用名称，不回退 UUID", () => {
  assert.deepEqual(productDisplay(null), { name: "商品信息待核对", code: null });
  assert.deepEqual(productDisplay({ name: " 欧洲瓷杯 ", sku_code: "A1" }), { name: "欧洲瓷杯", code: "商品编码 A1" });
  assert.equal(outboxNextAction("retry_wait"), "系统会自动重试；多次仍失败请联系总部");
  assert.equal(outboxNextAction("succeeded"), "任务已结束；若有赞库存仍异常，请总部核对");
});