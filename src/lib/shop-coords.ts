/**
 * 门店 GCJ-02 坐标校验（纯函数，浏览器/服务端共用）。
 *
 * 铁律：
 *  - 经纬度必须成对填写、成对清空；空值保持 null，绝不转 0；
 *  - 只接受 GCJ-02（腾讯/高德火星坐标系），禁止按地址推算或预填示例坐标；
 *  - 范围限制在中国境内（纬度 3–54，经度 73–136），最多 6 位小数；
 *  - 非法输入抛出中文业务错误，不静默吞掉。
 */

import { z } from "zod";

export type ShopCoordsInput = {
  latitude?: unknown;
  longitude?: unknown;
  coord_system?: unknown;
};

/** 保存 schema 的坐标字段：保留 coord_system 原值交给 normalize 拒绝，不 strip。 */
export const shopCoordFieldsSchema = z.object({
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  coord_system: z.string().nullable().optional(),
});

export type ShopCoordsPatch = {
  latitude: number | null;
  longitude: number | null;
  coord_system: "gcj02" | null;
};

const LAT_MIN = 3;
const LAT_MAX = 54;
const LNG_MIN = 73;
const LNG_MAX = 136;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function maxSixDecimals(v: number): boolean {
  return Math.abs(v * 1e6 - Math.round(v * 1e6)) < 1e-4;
}

/**
 * 校验并归一化坐标输入。
 * - 两者都缺省（undefined）→ 返回 null，表示本次不触碰坐标（地址等其它修改不清空已有坐标）。
 * - 两者都为 null → 返回清空补丁（成对清空）。
 * - 只给一个、非法类型、NaN/Infinity、越界、超过 6 位小数 → 抛中文错误。
 */
export function normalizeShopCoords(input: ShopCoordsInput): ShopCoordsPatch | null {
  const lat = input.latitude;
  const lng = input.longitude;
  const cs = input.coord_system;
  // 显式给出非 gcj02 一律拒绝：不做坐标转换，也不把 WGS84 原值标成 GCJ-02
  if (cs !== undefined && cs !== null && cs !== "gcj02") {
    throw new Error("仅接受 GCJ-02 坐标，不接受其它坐标系（不做转换）");
  }
  if (lat === undefined && lng === undefined) {
    if (cs !== undefined && cs !== null) throw new Error("坐标系必须与经纬度一起提交");
    return null;
  }

  if (lat === null && lng === null) {
    return { latitude: null, longitude: null, coord_system: null };
  }
  if (lat === null || lng === null || lat === undefined || lng === undefined) {
    throw new Error("纬度和经度必须成对填写或成对清空");
  }
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    throw new Error("坐标必须是有效数字");
  }
  if (lat < LAT_MIN || lat > LAT_MAX || lng < LNG_MIN || lng > LNG_MAX) {
    throw new Error("坐标超出中国范围（纬度 3–54，经度 73–136），请确认是 GCJ-02 坐标");
  }
  if (!maxSixDecimals(lat) || !maxSixDecimals(lng)) {
    throw new Error("坐标最多保留 6 位小数");
  }
  return { latitude: lat, longitude: lng, coord_system: "gcj02" };
}

/**
 * 构建门店信息更新补丁。coord_updated_at 不由服务端写，
 * 由数据库触发器在经纬度/坐标系真实变化（IS DISTINCT FROM）时写 now()。
 */
export function buildShopMetaPatch<T extends ShopCoordsInput & { id?: unknown }>(
  data: T,
): Record<string, unknown> {
  const { id: _id, latitude, longitude, coord_system, ...rest } = data;
  const coords = normalizeShopCoords({ latitude, longitude, coord_system });
  const patch: Record<string, unknown> = { ...rest };
  if (coords) Object.assign(patch, coords);
  return patch;
}
