import { createFileRoute } from "@tanstack/react-router";
import { publicERPInformation } from "@/server/erp-public-information.server";

export const Route = createFileRoute("/privacy")({
  server: { handlers: { GET: () => publicERPInformation("privacy") } },
});
