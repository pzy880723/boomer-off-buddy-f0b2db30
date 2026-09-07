// Read-only checks against the configured database. Never creates users or business records.
import { strict as assert } from "node:assert";
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { dashboardScope, loadSalesDashboard } from "../src/server/operational-dashboard.server";

const role = await supabaseAdmin
  .from("user_roles")
  .select("user_id")
  .eq("role", "super_admin")
  .limit(1)
  .single();
assert.ifError(role.error);
const scope = await dashboardScope(role.data!.user_id);
assert.equal(scope.isHq, true);
await assert.rejects(() => dashboardScope("00000000-0000-4000-8000-000000000000"));
await assert.rejects(() =>
  loadSalesDashboard(role.data!.user_id, { start: "2026-02-30", end: "2026-03-01" }),
);
await assert.rejects(() =>
  loadSalesDashboard(role.data!.user_id, {
    start: "2026-08-26",
    end: "2026-08-29",
    locationId: "00000000-0000-4000-8000-000000000000",
  }),
);
const all = await loadSalesDashboard(role.data!.user_id, {
  start: "2026-08-26",
  end: "2026-08-29",
  locationId: "all",
});
assert.equal(all.trend.length, 7);
assert.equal(all.metrics.netSalesFen, null);
assert.ok(
  all.tasks.every((task) => task.count !== null),
  "All task queries must return real counts",
);
assert.ok(all.metrics.orders > 0, "Known historical range must include real orders");
const stores = [];
for (const location of scope.locations) {
  const data = await loadSalesDashboard(role.data!.user_id, {
    start: "2026-08-26",
    end: "2026-08-29",
    locationId: location.id,
  });
  assert.equal(data.scopeLabel, location.name);
  assert.ok(
    data.tasks.every((task) => task.count !== null),
    "Store task queries must succeed",
  );
  stores.push({ name: location.name, metrics: data.metrics, tasks: data.tasks });
}
console.log(
  JSON.stringify(
    {
      verified_at: new Date().toISOString(),
      migration: "none",
      read_only: true,
      permission_checks: 3,
      all: {
        metrics: all.metrics,
        channels: all.channels,
        tasks: all.tasks,
        warnings: all.warnings,
      },
      stores,
    },
    null,
    2,
  ),
);
