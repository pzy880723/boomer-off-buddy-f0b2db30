import test from "node:test";
import assert from "node:assert/strict";
import { diffOfflinePayload, type OfflinePayload } from "./offline-sales-contract";

const base: OfflinePayload = {
  business_date: "2026-10-05", channel: "cash", amount_fen: 1200, order_count: 1,
  evidence_type: "pos_receipt", evidence_ref: "R1", evidence_url: null,
  youzan_exclusion_basis: "device_not_youzan", youzan_excluded_tids: ["b", "a"], note: null,
};

test("相同载荷可回放（tids 顺序、空串/null 视为一致）", () => {
  assert.deepEqual(diffOfflinePayload({ ...base, youzan_excluded_tids: ["a", "b"], note: "" as never }, base), []);
});

test("金额或渠道不同 → 冲突字段", () => {
  assert.deepEqual(diffOfflinePayload({ ...base, amount_fen: 1300 }, base), ["amount_fen"]);
  assert.deepEqual(diffOfflinePayload({ ...base, channel: "wechat_qr" }, base), ["channel"]);
});

test("数据库 numeric 以字符串返回也按数值比较", () => {
  assert.deepEqual(diffOfflinePayload({ ...base, amount_fen: "1200" as never }, base), []);
});
