import { describe, expect, it } from "vitest";
import { storefrontPrivateJson } from "@/server/storefront-auth.server";

describe("storefrontPrivateJson", () => {
  it("sets Cache-Control: private, no-store on order responses", async () => {
    const res = storefrontPrivateJson({ ok: true, data: { pickups: [] } });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true, data: { pickups: [] } });
  });

  it("keeps explicit status and cannot be overridden to a cacheable value", () => {
    const res = storefrontPrivateJson({ ok: true }, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
