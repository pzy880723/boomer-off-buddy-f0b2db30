import { describe, expect, it } from "vitest";
import { parseChangeCursor, parseListCursor } from "./handheld-notifications.server";

describe("notification cursors", () => {
  it("parses v2 change cursor and latest", () => {
    expect(parseChangeCursor("latest")).toBe("latest");
    expect(parseChangeCursor("v2:812:44")).toEqual({ xid: "812", seq: 44 });
    for (const bad of ["v2:x:1", "v1:1:1", "v2:1", "2026-01-01T00:00:00Z", "v2:1:1;drop"]) expect(parseChangeCursor(bad)).toBeNull();
  });
  it("parses composite list cursor; legacy ts stays legacy", () => {
    expect(parseListCursor("2026-01-01T00:00:00.000Z|00000000-0000-0000-0000-0000000000a1")).toEqual({
      ts: "2026-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-0000000000a1" });
    expect(parseListCursor("2026-01-01T00:00:00.000Z")).toBeNull();
    expect(parseListCursor("2026-01-01T00:00:00Z|x),or(id.gt.0")).toBeNull();
  });
});
