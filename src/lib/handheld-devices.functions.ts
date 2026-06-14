import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function randomToken(len = 40) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

export const listDevices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("inv_handheld_devices")
      .select(
        "id, device_code, label, token, is_active, last_seen_at, default_location_id, location:inv_locations!default_location_id(id, name, kind)"
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        device_code: z.string().min(1).max(64),
        label: z.string().min(1).max(120),
        default_location_id: z.string().uuid().nullable().optional(),
      })
      .parse(i)
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("inv_handheld_devices")
      .insert({
        device_code: data.device_code,
        label: data.label,
        default_location_id: data.default_location_id ?? null,
        token: randomToken(40),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const regenerateDeviceToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = randomToken(40);
    const { error } = await supabaseAdmin
      .from("inv_handheld_devices")
      .update({ token })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { token };
  });

export const setDeviceActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ id: z.string().uuid(), is_active: z.boolean() }).parse(i)
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("inv_handheld_devices")
      .update({ is_active: data.is_active })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateDeviceLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({ id: z.string().uuid(), default_location_id: z.string().uuid().nullable() })
      .parse(i)
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("inv_handheld_devices")
      .update({ default_location_id: data.default_location_id })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listLocationsForDevices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("inv_locations")
      .select("id, name, kind, is_active")
      .eq("is_active", true)
      .order("kind")
      .order("name");
    return data ?? [];
  });
