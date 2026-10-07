import assert from "node:assert/strict";
import { test } from "node:test";
import { staffDisplayName, staffAvatarPath, validateAvatarBytes, STAFF_AVATAR_MAX_BYTES, canMaintainStaffProfiles } from "./staff-profile";
import { SUPER_ADMIN_PHONES, phoneToEmail } from "./auth-config";

const U = "a0000000-0000-4000-8000-000000000001";
test("员工不能伪造个人 metadata 手机号取得账号维护权限", () => {
  const phone = SUPER_ADMIN_PHONES[0];
  assert.equal(canMaintainStaffProfiles({ email: "staff@example.test", user_metadata: { phone } }), false);
  assert.equal(canMaintainStaffProfiles({ email: phoneToEmail(phone) }), true);
  assert.equal(canMaintainStaffProfiles({ phone }), true);
});
test("姓名取 metadata.name，不用技术邮箱", () => {
  assert.equal(staffDisplayName({ name: " 张三 ", display_name: "x" }), "张三");
  assert.equal(staffDisplayName({ name: "13800000000@users.local" }), null);
  assert.equal(staffDisplayName({ name: "13800000000@user.local" }), null);
  assert.equal(staffDisplayName({ name: "13800000000" }), null);
  assert.equal(staffDisplayName({}), null);
  assert.equal(staffDisplayName(null), null);
});
test("头像路径只接受本人前缀服务端格式", () => {
  assert.equal(staffAvatarPath({ avatar_path: `${U}/abcd1234-ef.png` }, U), `${U}/abcd1234-ef.png`);
  assert.equal(staffAvatarPath({ avatar_path: `other/abcd1234.png` }, U), null);
  assert.equal(staffAvatarPath({ avatar_path: `https://x/y.png` }, U), null);
  assert.equal(staffAvatarPath({ avatar_path: `${U}/../x/abcdefgh.png` }, U), null);
});
test("头像按文件头校验格式和大小", () => {
  assert.equal(validateAvatarBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])).ok, true);
  assert.equal(validateAvatarBytes(new Uint8Array([0xff, 0xd8, 0xff, 0])).ok, true);
  assert.equal(validateAvatarBytes(new TextEncoder().encode("<svg></svg>")).ok, false);
  const big = new Uint8Array(STAFF_AVATAR_MAX_BYTES + 1); big.set([0xff, 0xd8, 0xff]);
  assert.equal(validateAvatarBytes(big).ok, false);
  assert.equal(validateAvatarBytes(new Uint8Array()).ok, false);
});
