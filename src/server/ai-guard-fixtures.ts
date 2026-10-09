// Test fixtures only: explicit guards so tests never rely on a default-allow path.
import type { AiOutboundGuard } from "./ai-guard.ts";

export const allowHandheldGuard: AiOutboundGuard = { kind: "handheld_staff", async check() {} };
export const allowWebGuard: AiOutboundGuard = { kind: "web_erp", async check() {} };
