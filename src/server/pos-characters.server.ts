import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function validatePosCharacters(items: Array<{ character_id?: string | null }>) {
  const ids = [...new Set(items.flatMap((item) => item.character_id ? [item.character_id] : []))];
  const names = new Map<string, string>();
  if (!ids.length) return { ok: true as const, names };
  const { data, error } = await supabaseAdmin.from("inv_facets")
    .select("id,name,dimension,is_active").in("id", ids);
  if (error) return { ok: false as const, message: error.message, status: 500 };
  for (const item of data ?? []) if (item.is_active && item.dimension === "character") names.set(item.id, item.name);
  if (names.size !== ids.length) return { ok: false as const, status: 422,
    message: "所选角色不存在或已停用，请重新选择" };
  return { ok: true as const, names };
}
