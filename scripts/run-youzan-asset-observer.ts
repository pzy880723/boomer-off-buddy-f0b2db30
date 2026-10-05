import { DatabaseSync } from "node:sqlite";
import { processObservationInbox, productionObservationDeps, supabaseObservationStore } from "../src/server/youzan-asset-observer.server";
import { productionPointsQuery } from "../src/server/youzan-points-query.server";
import { resolveMappedMember } from "./youzan-member-readonly.mjs";

// Run once from the host scheduler. The SQLite identity map is always opened read-only.
async function run() {
  if (process.env.YOUZAN_ASSET_OBSERVER_ENABLED !== "true") throw Error("observer_disabled");
  if (!process.env.YOUZAN_PROXY_URL || !process.env.YOUZAN_PROXY_TOKEN) throw Error("fixed_proxy_not_configured");
  const { supabaseAdmin } = await import("../src/integrations/supabase/client.server");
  const { data: shops, error } = await supabaseAdmin.from("youzan_shops")
    .select("kdt_id,parent_kdt_id,role,status").eq("status", "active");
  if (error) throw Error("authorized_shop_lookup_failed");
  const db = new DatabaseSync(process.env.YOUZAN_MEMBER_LINK_DB || "/var/lib/boomer-off/membership-youzan-links.sqlite", { readOnly: true });
  try {
    const deps = await productionObservationDeps({
      queryAsset: await productionPointsQuery(),
      async resolveIdentity({ kdt_id, yz_open_id }) {
        const links = db.prepare("SELECT customer_id,kdt_id,yz_id FROM member_channel_links WHERE yz_id=?").all(yz_open_id);
        const who = resolveMappedMember(shops ?? [], links, kdt_id, yz_open_id);
        if (!who) return { kind: "unknown" };
        const { data, error } = await supabaseAdmin.from("commerce_customers")
          .select("id").eq("id", who.customerId).eq("status", "active").maybeSingle();
        if (error) throw Error("member_lookup_failed");
        return data ? { kind: "found", customerId: data.id, yzOpenId: who.yzOpenId } : { kind: "unknown" };
      },
    });
    const result = await processObservationInbox(await supabaseObservationStore(), deps, { limit: 5 });
    console.log(JSON.stringify({ ok: true, mode: "observation_only", ...result, assetWrites: 0 }));
  } finally { db.close(); }
}

run().catch(() => {
  console.error(JSON.stringify({ ok: false, error: "asset_observer_failed", assetWrites: 0 }));
  process.exitCode = 1;
});
