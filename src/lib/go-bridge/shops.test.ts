import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildShopDirectory } from "./shops";

const LOC_A = "22222222-2222-4222-8222-222222222222";
const LOC_B = "33333333-3333-4333-8333-333333333333";

describe("buildShopDirectory (cross-project shop numbering contract)", () => {
  const locations = [
    { id: LOC_A, name: "中信泰富店" },
    { id: LOC_B, name: "温州朔门古港店" },
  ];

  it("emits go_shop_id / erp_location_id / name only from active explicit links", () => {
    const out = buildShopDirectory({
      links: [
        { go_shop_id: "go-1", location_id: LOC_A, status: "active" },
        { go_shop_id: "go-2", location_id: LOC_B, status: "revoked" },
      ],
      activeShops: locations,
    });
    assert.deepEqual(out, [{ go_shop_id: "go-1", erp_location_id: LOC_A, name: "中信泰富店" }]);
  });

  it("drops links whose ERP location is no longer an active shop", () => {
    const out = buildShopDirectory({
      links: [{ go_shop_id: "go-1", location_id: LOC_A, status: "active" }],
      activeShops: [{ id: LOC_B, name: "温州朔门古港店" }],
    });
    assert.deepEqual(out, []);
  });

  it("never guesses a binding by name or phone", () => {
    const out = buildShopDirectory({ links: [], activeShops: locations });
    assert.deepEqual(out, []);
  });
});
