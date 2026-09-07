import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getDashboardScope = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { dashboardScope } = await import("@/server/operational-dashboard.server");
    const scope = await dashboardScope(context.userId);
    return { isHq: scope.isHq, locations: scope.locations.map(({ id, name }) => ({ id, name })) };
  });

export const getSalesDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        start: z.string(),
        end: z.string(),
        locationId: z.union([z.string().uuid(), z.literal("all")]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { loadSalesDashboard } = await import("@/server/operational-dashboard.server");
    return loadSalesDashboard(context.userId, data);
  });
