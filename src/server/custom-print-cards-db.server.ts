// 真实依赖：service_role 访问 custom_print_cards（RLS 无对外策略），授权在核心层先做完。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles, userCanAccessLocation } from "@/server/handheld-auth.server";
import { generateCardCopy } from "@/server/custom-print-cards-ai.server";
import { type CardRow, type CustomCardDeps } from "@/server/custom-print-cards.server";

const T = "custom_print_cards" as never;
const COLS = "id,location_id,topic,instructions,formats,reference_image_path,reference_device_id,content,state,status,error,version,client_op_id,created_by,job_token,created_at,updated_at";
const MAX_REF_BYTES = 20 * 1024 * 1024;
const db = () => supabaseAdmin.from(T) as any;

function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (String.fromCharCode(...b.slice(4, 8)) === "ftyp") return "image/heic";
  return null;
}

export function customCardDeps(): CustomCardDeps {
  return {
    roles: loadUserRoles,
    canAccess: userCanAccessLocation,
    list: async ({ state, location_id }) => {
      let q = db().select(COLS).eq("state", state).order("updated_at", { ascending: false }).limit(500);
      if (state === "custom") q = q.eq("location_id", location_id);
      const { data, error } = await q;
      if (error) throw error;
      return data as CardRow[];
    },
    get: async (id) => {
      const { data, error } = await db().select(COLS).eq("id", id).maybeSingle();
      if (error) throw error;
      return data as CardRow | null;
    },
    insertIdempotent: async (row) => {
      const { data, error } = await db().insert(row).select(COLS).maybeSingle();
      if (!error) return { card: data as CardRow, created: true };
      if (error.code !== "23505") throw error;
      const hit = await db().select(COLS).eq("created_by", row.created_by).eq("client_op_id", row.client_op_id).maybeSingle();
      if (hit.error || !hit.data) throw hit.error ?? new Error("idempotency lookup failed");
      return { card: hit.data as CardRow, created: false };
    },
    updateCas: async (id, v, patch, requireState) => {
      const extra: Record<string, unknown> = {};
      if (patch.state === "preset") extra.published_at = new Date().toISOString();
      if (patch.job_token === null) extra.lease_until = null;
      let q = db().update({ ...patch, ...extra, version: v + 1, updated_at: new Date().toISOString() }).eq("id", id).eq("version", v);
      if (requireState) q = q.eq("state", requireState);
      const { data, error } = await q.select(COLS).maybeSingle();
      if (error) throw error;
      return data as CardRow | null;
    },
    deleteCas: async (id, v) => {
      const { data, error } = await db().delete().eq("id", id).eq("version", v).select("id");
      if (error) throw error;
      return (data ?? []).length === 1;
    },
    claim: async (limit) => {
      const { data, error } = await (supabaseAdmin.rpc as any)("custom_print_card_claim", { p_limit: limit, p_lease_seconds: 180 });
      if (error) throw error;
      return data as CardRow[];
    },
    finish: async (id, token, v, patch) => {
      const { data, error } = await db()
        .update({ ...patch, job_token: null, lease_until: null, version: v + 1, updated_at: new Date().toISOString() })
        .eq("id", id).eq("job_token", token).eq("version", v).eq("status", "processing").select("id");
      if (error) throw error;
      return (data ?? []).length === 1;
    },
    verifyReference: async (path) => {
      const { data, error } = await supabaseAdmin.storage.from("sku-raw").download(path);
      if (error || !data || data.size === 0 || data.size > MAX_REF_BYTES) return false;
      return sniff(new Uint8Array(await data.slice(0, 16).arrayBuffer())) !== null;
    },
    loadReference: async (path) => {
      const { data, error } = await supabaseAdmin.storage.from("sku-raw").download(path);
      if (error || !data) throw new Error("reference unavailable");
      if (data.size > MAX_REF_BYTES) throw new Error("reference too large");
      const bytes = new Uint8Array(await data.arrayBuffer());
      const mime = sniff(bytes);
      if (!mime) throw new Error("reference not an image");
      return { mime, b64: Buffer.from(bytes).toString("base64") };
    },
    generate: async (input) => {
      const key = process.env.LOVABLE_API_KEY;
      if (!key) throw new Error("AI not configured");
      return generateCardCopy({ key, input });
    },
  };
}
