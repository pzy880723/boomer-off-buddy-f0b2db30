// 服务端坐标鉴权逻辑测试（注入假的数据库客户端，非真实 HTTP / 非真实数据库）。
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertCoordWriteAllowed, hasCoordFields, assertUpdatedOneRow } from "./shop-coords-auth";

type Row = { role: string };
function fakeClient(rows: Row[], err: unknown = null) {
  const calls: Array<[string, unknown]> = [];
  const q = {
    select() { return q; },
    eq(col: string, v: unknown) { calls.push([col, v]); return q; },
    then(res: (v: { data: Row[] | null; error: unknown }) => unknown) {
      return Promise.resolve({ data: err ? null : rows, error: err }).then(res);
    },
  };
  return { client: { from: (t: string) => { calls.push(["table", t]); return q; } }, calls };
}

describe("hasCoordFields", () => {
  test("未提交任何坐标字段 → false", () => assert.equal(hasCoordFields({ address: "x" }), false));
  test("提交 null 清空也算坐标写入", () => assert.equal(hasCoordFields({ latitude: null, longitude: null }), true));
  test("仅 coord_system 也算", () => assert.equal(hasCoordFields({ coord_system: "gcj02" }), true));
});

describe("assertCoordWriteAllowed", () => {
  test("super_admin 允许，且按认证 userId 查 user_roles", async () => {
    const { client, calls } = fakeClient([{ role: "super_admin" }]);
    await assertCoordWriteAllowed(client as never, "u1");
    assert.deepEqual(calls[0], ["table", "user_roles"]);
    assert.ok(calls.some(([c, v]) => c === "user_id" && v === "u1"));
  });
  for (const role of ["store_manager", "store_staff", "hq_operator"]) {
    test(`${role} 拒绝`, async () => {
      const { client } = fakeClient([{ role }]);
      await assert.rejects(assertCoordWriteAllowed(client as never, "u1"), /仅总部管理员/);
    });
  }
  test("无角色（伪造 metadata 不被读取）拒绝", async () => {
    const { client } = fakeClient([]);
    await assert.rejects(assertCoordWriteAllowed(client as never, "u1"), /仅总部管理员/);
  });
  test("匿名（无 userId）拒绝", async () => {
    const { client } = fakeClient([{ role: "super_admin" }]);
    await assert.rejects(assertCoordWriteAllowed(client as never, ""), /仅总部管理员/);
  });
  test("查角色出错时拒绝，不放行", async () => {
    const { client } = fakeClient([], { message: "boom" });
    await assert.rejects(assertCoordWriteAllowed(client as never, "u1"));
  });
});

describe("assertUpdatedOneRow", () => {
  test("0 行（RLS 静默过滤）视为失败", () => {
    assert.throws(() => assertUpdatedOneRow([]), /未保存/);
    assert.throws(() => assertUpdatedOneRow(null), /未保存/);
  });
  test("1 行成功", () => assert.doesNotThrow(() => assertUpdatedOneRow([{ id: "s" }])));
});
