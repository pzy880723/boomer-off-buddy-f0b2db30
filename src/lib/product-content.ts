import { z } from "zod";

const plainText = z
  .string()
  .min(1)
  .max(4000)
  .refine(
    (value) => !/[<>]/.test(value) && !/(?:https?:\/\/|data:|javascript:)/i.test(value),
    "Content must be plain text, without HTML or URLs",
  );
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const storagePath = z
  .string()
  .max(2048)
  .regex(/^sku-(?:raw|listing)\/[A-Za-z0-9_./-]+$/)
  .refine((value) =>
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );

export const ProductContentBlock = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("heading"), text: plainText }).strict(),
  z.object({ id, type: z.literal("paragraph"), text: plainText }).strict(),
  z.object({ id, type: z.literal("facts"), text: plainText }).strict(),
  z
    .object({
      id,
      type: z.literal("image"),
      storage_path: storagePath,
      caption: plainText.optional(),
    })
    .strict(),
]);
export type ProductContentBlock = z.infer<typeof ProductContentBlock>;
export type ProductContentReadBlock = ProductContentBlock & { read_url?: string | null };
export const ProductContentBlocks = z
  .array(ProductContentBlock)
  .max(80)
  .refine(
    (blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length,
    "Block IDs must be unique",
  );

const location_id = z.string().uuid().optional();
export const ProductContentRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), location_id }).strict(),
  z
    .object({ action: z.literal("generate"), location_id, blocks: ProductContentBlocks.optional() })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      location_id,
      expected_version: z.number().int().min(0).max(2147483646),
      client_op_id: z.string().min(8).max(128),
      blocks: ProductContentBlocks,
      publish: z.boolean().optional(),
    })
    .strict(),
]);

/** Replace text only; raw images keep their identity and relative placement. */
export function mergeProductContentPreview(
  base: ProductContentBlock[],
  generated: ProductContentBlock[],
): ProductContentBlock[] {
  const text = generated.filter((block) => block.type !== "image");
  let index = 0;
  const result = base.flatMap<ProductContentBlock>((block) =>
    block.type === "image" ? [block] : text[index] ? [text[index++]] : [],
  );
  return ProductContentBlocks.parse([...result, ...text.slice(index)]);
}
