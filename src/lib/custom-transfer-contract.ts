import { z } from "zod";

const uuid = z.string().uuid();
const Product = z.object({
  sku_id: uuid,
  name: z.string(),
  sku_code: z.string(),
  barcode: z.string(),
  price: z.number(),
  qty: z.number().int(),
  available_qty: z.number().int(),
  image_url: z.string(),
});
const Photo = z.object({ id: uuid, url: z.string(), used: z.boolean() });
const Transfer = z.object({
  id: uuid,
  code: z.string(),
  status: z.enum(["in_transit", "received"]),
  qty: z.number().int(),
  from_location_id: uuid,
  to_location_id: uuid,
  from_name: z.string(),
  to_name: z.string(),
  notes: z.string(),
  created_at: z.string(),
  received_at: z.string().nullable(),
  can_receive: z.boolean(),
  source_sync_pending: z.boolean(),
  lines: z.array(Product),
  photos: z.array(Photo),
});
export const CustomTransferResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    actor_id: uuid.optional(),
    items: z.array(Transfer).optional(),
    locations: z
      .array(z.object({ id: uuid, name: z.string(), kind: z.enum(["warehouse", "shop"]) }))
      .optional(),
    can_create: z.boolean().optional(),
    has_more: z.boolean().optional(),
    products: z.array(Product).optional(),
    transfer: Transfer.optional(),
    id: uuid.optional(),
    code: z.string().optional(),
    status: z.string().optional(),
    replayed: z.boolean().optional(),
    photo: Photo.omit({ used: true }).optional(),
  }),
});
export const CustomTransferRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    location_id: uuid.optional(),
    q: z.string().trim().max(100).default(""),
    status: z.enum(["all", "in_transit", "received"]).default("all"),
    page: z.number().int().min(1).max(10000).default(1),
  }),
  z.object({
    action: z.literal("products"),
    location_id: uuid,
    q: z.string().trim().max(100).default(""),
  }),
  z.object({ action: z.literal("detail"), id: uuid }),
  z.object({
    action: z.literal("create"),
    client_op_id: z.string().min(1).max(100),
    from_location_id: uuid,
    to_location_id: uuid,
    notes: z.string().trim().max(1000).default(""),
    lines: z
      .array(z.object({ sku_id: uuid, qty: z.number().int().positive().max(10000) }))
      .min(1)
      .max(100),
  }),
  z.object({
    action: z.literal("upload"),
    id: uuid,
    image_base64: z.string().min(8).max(7_000_000),
  }),
  z.object({ action: z.literal("receive"), id: uuid, photo_ids: z.array(uuid).min(1).max(6) }),
]);
export type CustomTransferInput = z.infer<typeof CustomTransferRequest>;
export type TransferProduct = {
  sku_id: string;
  name: string;
  sku_code: string;
  barcode: string;
  price: number;
  qty: number;
  available_qty: number;
  image_url: string;
};
export type CustomTransfer = {
  id: string;
  code: string;
  status: string;
  qty: number;
  from_location_id: string;
  to_location_id: string;
  from_name: string;
  to_name: string;
  notes: string;
  created_at: string;
  received_at: string | null;
  can_receive: boolean;
  lines: TransferProduct[];
  photos: { id: string; url: string; used: boolean }[];
  source_sync_pending: boolean;
};
export type TransferResult = {
  actor_id?: string;
  error?: { code: string; message: string };
  items?: CustomTransfer[];
  locations?: { id: string; name: string; kind: string }[];
  can_create?: boolean;
  has_more?: boolean;
  products?: TransferProduct[];
  transfer?: CustomTransfer;
  id?: string;
  code?: string;
  status?: string;
  photo?: { id: string; url: string };
};
