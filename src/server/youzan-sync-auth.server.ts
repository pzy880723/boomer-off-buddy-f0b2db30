import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Publishable/anon keys and browser sessions are not background-job credentials.
export function requireYouzanSyncService(request: Request): Response | null {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return Response.json({ ok: false, code: "sync_not_configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${serviceRoleKey}`) {
    return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function assertYouzanSyncOperator(userId: string) {
  if (!userId) throw new Response("Unauthorized", { status: 401 });
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw new Response("Sync permission unavailable", { status: 503 });
  if (!data?.some(({ role }) => role === "super_admin" || role === "hq_operator")) {
    throw new Response("仅总部管理员可同步有赞", { status: 403 });
  }
}

export function dispatchYouzanSyncWorker(body: {
  shop_id: string;
  action: "items" | "orders";
  days?: number;
}) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const port = process.env.ERP_PORT ?? "3005";
  if (!serviceRoleKey || (port !== "3005" && port !== "3006")) {
    throw new Error("Youzan sync worker not configured");
  }
  // Never forward this credential to an origin derived from an incoming request.
  void fetch(`http://127.0.0.1:${port}/api/public/hooks/youzan-sync-worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify(body),
    redirect: "error",
  }).catch(() => {
    // Fetch errors may contain request details; do not log the credential-bearing request.
    console.error("[youzan sync dispatch] worker request failed");
  });
}
