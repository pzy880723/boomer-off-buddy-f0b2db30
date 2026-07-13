import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getSmartCreateReleaseTarget } from "./handheld-smart-create.server";

describe("handheld smart-create auto listing", () => {
  test("publishes to the shop bound to the selected store location", () => {
    assert.equal(
      getSmartCreateReleaseTarget({
        autoPushYouzan: true,
        locationKind: "shop",
        shopId: "shop-1",
      }),
      "shop-1",
    );
  });

  test("does not publish warehouse inventory to an arbitrary shop", () => {
    assert.equal(
      getSmartCreateReleaseTarget({
        autoPushYouzan: true,
        locationKind: "warehouse",
        shopId: null,
      }),
      null,
    );
  });

  test("respects an explicit auto-publish opt out", () => {
    assert.equal(
      getSmartCreateReleaseTarget({
        autoPushYouzan: false,
        locationKind: "shop",
        shopId: "shop-1",
      }),
      null,
    );
  });
});
