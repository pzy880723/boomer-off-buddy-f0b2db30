import test from "node:test";
import assert from "node:assert/strict";
import { printStoreQr, type QrPrintDeps } from "./store-qr-print.server";

const LOC = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-bytes")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]);

function deps(p: Partial<QrPrintDeps> = {}) {
  const log = { uploads: [] as { path: string; bytes: Uint8Array; mime: string }[], removed: [] as string[], saved: [] as any[] };
  const d: QrPrintDeps = {
    canAccessLocation: async () => true,
    roles: async () => ["store_staff"],
    list: async () => [],
    sign: async (_b, path) => `https://signed/${path}?ttl=300`,
    upload: async (path, bytes, mime) => { log.uploads.push({ path, bytes, mime }); },
    remove: async (path) => { log.removed.push(path); },
    saveImage: async (r) => { log.saved.push(r); return { updated_at: "2026-10-05T00:00:00Z" }; },
    newObjectId: () => "0f8fad5b-d9cb-469f-a165-70867728950e",
    ...p,
  };
  return { d, log };
}
const admin = { roles: async () => ["super_admin"] };
const save = (o: Record<string, unknown> = {}) => ({ action: "save", location_id: LOC, channel: "wechat", image_base64: PNG.toString("base64"), mime_type: "image/png", ...o });

test("get：跨店 403", async () => {
  const { d } = deps({ canAccessLocation: async () => false });
  assert.equal(((await printStoreQr(d, "u", { action: "get", location_id: LOC })) as any).status, 403);
});

test("get：仅 active 且有图的渠道返回短签名；停用/缺码不返回；can_manage 仅 super_admin", async () => {
  const rows = [
    { purpose: "wechat_follow", target_url: null, image_bucket: "store-qr", image_path: `${LOC}/wechat/0f8fad5b-d9cb-469f-a165-70867728950e.png`, status: "active", version: 3, updated_at: "t1" },
    { purpose: "dianping", target_url: null, image_bucket: "store-qr", image_path: `${LOC}/dianping/b.png`, status: "disabled", version: 2, updated_at: "t2" },
    { purpose: "mini_program", target_url: "https://x", image_bucket: null, image_path: null, status: "active", version: 1, updated_at: "t3" },
    { purpose: "wecom_contact", target_url: null, image_bucket: "store-qr", image_path: "x.png", status: "active", version: 1, updated_at: "t4" },
  ] as any;
  const { d } = deps({ list: async () => rows });
  const r: any = await printStoreQr(d, "u", { action: "get", location_id: LOC });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body.channels, [{ channel: "wechat", image_url: `https://signed/${LOC}/wechat/0f8fad5b-d9cb-469f-a165-70867728950e.png?ttl=300`, updated_at: "t1" }]);
  assert.equal(r.body.can_manage, false);
  const { d: d2 } = deps({ ...admin, list: async () => rows });
  assert.equal(((await printStoreQr(d2, "u", { action: "get", location_id: LOC })) as any).body.can_manage, true);
});

for (const role of ["store_staff", "store_manager", "hq_operator"]) {
  test(`save：${role} 403，且不上传不落库`, async () => {
    const { d, log } = deps({ roles: async () => [role] });
    assert.equal(((await printStoreQr(d, "u", save())) as any).code, "admin_only");
    assert.equal(log.uploads.length + log.saved.length, 0);
  });
}

test("save：任意外部 image_path / 未知字段被拒", async () => {
  const { d, log } = deps(admin);
  assert.equal(((await printStoreQr(d, "u", save({ image_path: "other/evil.png" }))) as any).status, 422);
  assert.equal(log.uploads.length, 0);
});

test("save：伪装格式 / mime 不符 / 超 15MB / 空 → 422 且不上传", async () => {
  const { d, log } = deps(admin);
  for (const b of [
    save({ image_base64: Buffer.from("GIF89a....").toString("base64") }),
    save({ mime_type: "image/jpeg" }),
    save({ mime_type: "image/gif" }),
    save({ image_base64: "" }),
    save({ image_base64: Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]).toString("base64") }),
  ]) assert.equal(((await printStoreQr(d, "u", b)) as any).status, 422);
  assert.equal(log.uploads.length, 0);
});

test("save：原样字节上传至 location/channel/不可猜 ID，落库 active，返回签名", async () => {
  const { d, log } = deps(admin);
  const r: any = await printStoreQr(d, "u", save({ channel: "dianping", image_base64: JPG.toString("base64"), mime_type: "image/jpeg" }));
  assert.equal(r.ok, true);
  assert.equal(log.uploads[0].path, `${LOC}/dianping/0f8fad5b-d9cb-469f-a165-70867728950e.jpg`);
  assert.ok(Buffer.from(log.uploads[0].bytes).equals(JPG));
  assert.deepEqual(log.saved[0], { location_id: LOC, purpose: "dianping", image_path: log.uploads[0].path, updated_by: "u" });
  assert.equal(r.body.channel.channel, "dianping");
  assert.match(r.body.channel.image_url, /^https:\/\/signed\//);
  assert.equal(log.removed.length, 0);
});

test("save：上传失败 → 500 不落库", async () => {
  const { d, log } = deps({ ...admin, upload: async () => { throw new Error("x"); } });
  assert.equal(((await printStoreQr(d, "u", save())) as any).ok, false);
  assert.equal(log.saved.length, 0);
});

test("save：DB 失败 → 不报成功，仅清理本次新对象（不删旧版本）", async () => {
  const { d, log } = deps({ ...admin, saveImage: async () => { throw new Error("db"); } });
  const r: any = await printStoreQr(d, "u", save());
  assert.equal(r.ok, false);
  assert.deepEqual(log.removed, [`${LOC}/wechat/0f8fad5b-d9cb-469f-a165-70867728950e.png`]);
  const { d: d2, log: l2 } = deps({ ...admin, saveImage: async () => null });
  assert.equal(((await printStoreQr(d2, "u", save())) as any).ok, false);
  assert.equal(l2.removed.length, 1);
});
