import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

export type OrgAddress = {
  id: string;
  label: string;
  receiver_name: string | null;
  receiver_phone: string | null;
  address: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export const listAddresses = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await supabase
    .from("org_addresses")
    .select("*")
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as OrgAddress[];
});

const UpsertInput = z.object({
  id: z.string().uuid().nullable().optional(),
  label: z.string().min(1),
  receiver_name: z.string().nullable().optional(),
  receiver_phone: z.string().nullable().optional(),
  address: z.string().min(1),
  is_default: z.boolean().optional(),
});

export const upsertAddress = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => UpsertInput.parse(data))
  .handler(async ({ data }) => {
    const payload = {
      label: data.label,
      receiver_name: data.receiver_name ?? null,
      receiver_phone: data.receiver_phone ?? null,
      address: data.address,
      is_default: data.is_default ?? false,
    };
    if (data.is_default) {
      await supabase.from("org_addresses").update({ is_default: false }).eq("is_default", true);
    }
    if (data.id) {
      const { error } = await supabase.from("org_addresses").update(payload).eq("id", data.id);
      if (error) throw error;
      return { id: data.id };
    }
    const { data: row, error } = await supabase
      .from("org_addresses")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw error;
    return { id: row!.id as string };
  });

export const deleteAddress = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { error } = await supabase.from("org_addresses").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const setDefaultAddress = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await supabase.from("org_addresses").update({ is_default: false }).eq("is_default", true);
    const { error } = await supabase
      .from("org_addresses")
      .update({ is_default: true })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
