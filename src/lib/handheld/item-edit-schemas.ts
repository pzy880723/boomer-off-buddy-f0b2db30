/**
 * 手持端商品修改 / 删除契约（PATCH / DELETE /api/public/handheld/items/{id}）。
 * 图片使用稳定存储路径，不接受临时签名 URL；条码、库存、分类等不可改。
 */
import * as z from "zod";

const uuid = z.string().uuid();
const clientOpId = z.string().min(8).max(128);

const imagePath = z.string().min(1).max(2048).refine(
  (v) => /^(sku-raw\/|sku-listing\/|https:\/\/)/.test(v)
    && !/[?#\s]/.test(v) && !v.split("/").includes(".."),
  "图片需使用稳定存储路径，不能使用临时签名地址",
);

export const ItemPriceYuan = z
  .number()
  .finite()
  .gt(0, "价格需大于 0")
  .lt(1_000_000)
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, "价格以元为单位，最多两位小数");

export const ItemPatchReq = z
  .object({
    location_id: uuid,
    client_op_id: clientOpId,
    expected_updated_at: z.string().datetime({ offset: true }),
    name: z.string().trim().min(1).max(200).optional(),
    price_tier: ItemPriceYuan.optional(),
    description: z.string().max(2000).nullable().optional(),
    condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable().optional(),
    image_paths: z.array(imagePath).max(20).refine(v => new Set(v).size === v.length, "图片不能重复").optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.name !== undefined ||
      b.price_tier !== undefined ||
      b.description !== undefined ||
      b.condition_grade !== undefined || b.image_paths !== undefined,
    { message: "至少修改一个字段" },
  );

export const ItemDeleteReq = z
  .object({
    location_id: uuid,
    client_op_id: clientOpId,
    confirm: z.literal(true),
  })
  .strict();

const env = <T extends z.ZodTypeAny>(data: T) => z.object({ ok: z.literal(true), data });

export const ItemPatchRes = env(
  z.object({
    sku_id: uuid,
    updated_at: z.string(),
    changed_fields: z.array(z.enum(["name", "price_tier", "notes", "grade", "image_paths"])),
    replayed: z.boolean(),
    youzan_sync_queued: z.number().int().describe("已持久化的有赞改名/改价任务数（异步，由腾讯 worker 执行）"),
  }),
);

export const ItemDeleteRes = env(z.object({ deleted_sku_id: uuid, replayed: z.boolean() }));

export const ItemCapabilities = z.object({
  can_edit: z.boolean().describe("当前员工在当前库位可修改；standard 恒为 false"),
  can_delete: z
    .boolean()
    .describe("仅表示有删除权限（总部）；不保证无业务引用，实际删除可能返回 409 delete_blocked"),
  updated_at: z.string().describe("PATCH 需回传为 expected_updated_at"),
});
