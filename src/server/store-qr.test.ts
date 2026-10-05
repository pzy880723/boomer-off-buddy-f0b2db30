import test from "node:test";
import assert from "node:assert/strict";
import { listStoreQr, saveStoreQr, type QrDeps } from "./store-qr.server";

function deps(p: Partial<QrDeps> = {}): QrDeps {
  return {
    canAccessLocation: async () => true,
    roles: async () => ["store_staff"],
    list: async () => [],
    sign: async () => "https://signed",
    upsert: async (r) => ({ ...r, image_bucket: null, image_path: null, version: 1, updated_at: "t" }),
    ...p,
  };
}
const LOC = "11111111-1111-1111-1111-111111111111";

test("无库位权限读取 → 403", async () => {
  const r = await listStoreQr(deps({ canAccessLocation: async () => false }), "u", LOC);
  assert.equal(r.ok ? 0 : r.status, 403);
});

test("未配置用途返回 pending，不伪造二维码", async () => {
  const r = await listStoreQr(deps(), "u", LOC);
  assert.ok(r.ok);
  assert.equal(r.items.length, 4);
  assert.ok(r.items.every((i) => i.status === "pending" && !i.image_read_url && !i.target_url));
});

test("停用的配置不下发链接/图片；启用图片只给签名 URL", async () => {
  const r = await listStoreQr(deps({ list: async () => [
    { purpose: "storefront", target_url: "https://a", image_bucket: null, image_path: null, status: "disabled", version: 2, updated_at: "t" },
    { purpose: "wecom_contact", target_url: null, image_bucket: "store-qr", image_path: "p.png", status: "active", version: 1, updated_at: "t" },
  ] }), "u", LOC);
  assert.ok(r.ok);
  const sf = r.items.find((i) => i.purpose === "storefront")!;
  assert.equal(sf.target_url, null);
  const wc = r.items.find((i) => i.purpose === "wecom_contact")!;
  assert.equal(wc.image_read_url, "https://signed");
  assert.equal("image_path" in wc, false);
});

for (const role of ["store_staff", "store_manager", "hq_operator"]) {
  test(`${role} 写入 → 403 且不落库`, async () => {
    let wrote = false;
    const r = await saveStoreQr(deps({ roles: async () => [role], upsert: async () => { wrote = true; return null; } }), "u",
      { location_id: LOC, purpose: "storefront", target_url: "https://x", status: "active" });
    assert.equal(r.ok ? 0 : r.code, "admin_only");
    assert.equal(wrote, false);
  });
}

test("super_admin：非 https / 启用无链接 → 422；合法 → 保存；0 行 → 409", async () => {
  const admin = deps({ roles: async () => ["super_admin"] });
  assert.equal(((await saveStoreQr(admin, "u", { location_id: LOC, purpose: "storefront", target_url: "http://x", status: "active" })) as any).status, 422);
  assert.equal(((await saveStoreQr(admin, "u", { location_id: LOC, purpose: "storefront", target_url: null, status: "active" })) as any).status, 422);
  assert.equal((await saveStoreQr(admin, "u", { location_id: LOC, purpose: "storefront", target_url: "https://example.com/s", status: "active" })).ok, true);
  const none = deps({ roles: async () => ["super_admin"], upsert: async () => null });
  assert.equal(((await saveStoreQr(none, "u", { location_id: LOC, purpose: "storefront", target_url: null, status: "pending" })) as any).status, 409);
});
