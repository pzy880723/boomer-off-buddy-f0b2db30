/**
 * 离线幂等：APP 端为每个写请求生成 client_op_id，
 * 服务端用 (device_id, client_op_id) 唯一键回放上一次的响应。
 *
 * 用法：
 *   const replay = await replayIfPresent({ deviceId, clientOpId, opType });
 *   if (replay) return jsonReplay(replay);
 *   ... do work ...
 *   await recordOp({ deviceId, clientOpId, opType, status: 200, body });
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HANDHELD_CORS } from "@/server/handheld-auth.server";

export type OpLogRow = {
  response_status: number;
  response_json: unknown;
};

export async function replayIfPresent(args: {
  deviceId: string;
  clientOpId: string | null | undefined;
  opType: string;
}): Promise<OpLogRow | null> {
  if (!args.clientOpId) return null;
  const { data } = await supabaseAdmin
    .from("inv_handheld_op_log" as never)
    .select("response_status, response_json")
    .eq("device_id", args.deviceId)
    .eq("client_op_id", args.clientOpId)
    .maybeSingle();
  return (data as OpLogRow | null) ?? null;
}

export async function recordOp(args: {
  deviceId: string;
  clientOpId: string | null | undefined;
  opType: string;
  status: number;
  body: unknown;
}): Promise<void> {
  if (!args.clientOpId) return;
  await supabaseAdmin
    .from("inv_handheld_op_log" as never)
    .upsert(
      {
        device_id: args.deviceId,
        client_op_id: args.clientOpId,
        op_type: args.opType,
        response_status: args.status,
        response_json: args.body as never,
      },
      { onConflict: "device_id,client_op_id", ignoreDuplicates: true },
    );
}

export function jsonReplay(row: OpLogRow): Response {
  const body =
    row.response_json && typeof row.response_json === "object"
      ? { ...(row.response_json as Record<string, unknown>), replayed: true }
      : { ok: true, data: row.response_json, replayed: true };
  return new Response(JSON.stringify(body), {
    status: row.response_status || 200,
    headers: { "Content-Type": "application/json", ...HANDHELD_CORS },
  });
}
