/**
 * 门店二维码配置读取/写入核心（依赖注入，便于权限测试）。
 * - 读：员工须有该库位权限；无配置的用途返回 status=pending，绝不伪造二维码。
 * - 写：仅 super_admin；hq_operator/店长/店员一律拒绝。图片只回签名 URL，不公开私桶路径。
 */
import { z } from "zod";

export const QR_PURPOSES = ["wechat_follow", "wecom_contact", "mini_program", "storefront"] as const;
export type QrPurpose = (typeof QR_PURPOSES)[number];

export type QrRow = {
  purpose: QrPurpose;
  target_url: string | null;
  image_bucket: string | null;
  image_path: string | null;
  status: "pending" | "active" | "disabled";
  version: number;
  updated_at: string;
};

export type QrDeps = {
  canAccessLocation(userId: string, locationId: string): Promise<boolean>;
  roles(userId: string): Promise<string[]>;
  list(locationId: string): Promise<QrRow[]>;
  sign(bucket: string, path: string): Promise<string | null>;
  upsert(row: { location_id: string; purpose: QrPurpose; target_url: string | null; status: QrRow["status"]; updated_by: string }): Promise<QrRow | null>;
};

export type QrView = {
  purpose: QrPurpose;
  status: "pending" | "active" | "disabled";
  target_url: string | null;
  image_read_url: string | null;
  version: number | null;
  updated_at: string | null;
};

export async function listStoreQr(deps: QrDeps, userId: string, locationId: string) {
  if (!(await deps.canAccessLocation(userId, locationId)))
    return { ok: false as const, status: 403, code: "location_forbidden" };
  const rows = new Map((await deps.list(locationId)).map((r) => [r.purpose, r]));
  const items: QrView[] = [];
  for (const purpose of QR_PURPOSES) {
    const r = rows.get(purpose);
    if (!r) {
      items.push({ purpose, status: "pending", target_url: null, image_read_url: null, version: null, updated_at: null });
      continue;
    }
    const active = r.status === "active";
    const url = active && r.image_bucket && r.image_path ? await deps.sign(r.image_bucket, r.image_path).catch(() => null) : null;
    items.push({
      purpose,
      status: r.status,
      target_url: active ? r.target_url : null,
      image_read_url: url,
      version: r.version,
      updated_at: r.updated_at,
    });
  }
  return { ok: true as const, items };
}

export const QrWrite = z
  .object({
    location_id: z.string().uuid(),
    purpose: z.enum(QR_PURPOSES),
    target_url: z.string().url().startsWith("https://").max(500).nullable(),
    status: z.enum(["pending", "active", "disabled"]),
  })
  .strict()
  .refine((v) => v.status !== "active" || !!v.target_url, { message: "active_requires_target" });

export async function saveStoreQr(deps: QrDeps, userId: string, body: unknown) {
  const roles = await deps.roles(userId);
  if (!roles.includes("super_admin")) return { ok: false as const, status: 403, code: "admin_only" };
  const parsed = QrWrite.safeParse(body);
  if (!parsed.success) return { ok: false as const, status: 422, code: "validation_error" };
  const row = await deps.upsert({ ...parsed.data, updated_by: userId });
  if (!row) return { ok: false as const, status: 409, code: "not_saved" };
  return { ok: true as const, item: row };
}
