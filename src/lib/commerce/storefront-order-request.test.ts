import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeStorefrontOrderItems } from "./storefront-order-request";

describe("storefront order request", () => {
  test("accepts quantity-aware items", () => {
    assert.deepEqual(
      normalizeStorefrontOrderItems({
        items: [
          { listing_id: "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf", quantity: 2 },
          { listing_id: "5df4ae35-f92f-475f-aa63-3f7d5d6d3dd7", quantity: 1 },
        ],
      }),
      [
        { listing_id: "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf", quantity: 2 },
        { listing_id: "5df4ae35-f92f-475f-aa63-3f7d5d6d3dd7", quantity: 1 },
      ],
    );
  });

  test("keeps legacy listing_ids compatible", () => {
    assert.deepEqual(
      normalizeStorefrontOrderItems({
        listing_ids: [
          "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf",
          "5df4ae35-f92f-475f-aa63-3f7d5d6d3dd7",
        ],
      }),
      [
        { listing_id: "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf", quantity: 1 },
        { listing_id: "5df4ae35-f92f-475f-aa63-3f7d5d6d3dd7", quantity: 1 },
      ],
    );
  });

  test("rejects duplicate listings and invalid quantities", () => {
    assert.throws(
      () =>
        normalizeStorefrontOrderItems({
          items: [
            { listing_id: "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf", quantity: 1 },
            { listing_id: "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf", quantity: 1 },
          ],
        }),
      /duplicate/i,
    );
    assert.throws(
      () =>
        normalizeStorefrontOrderItems({
          items: [{ listing_id: "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf", quantity: 0 }],
        }),
      /quantity/i,
    );
  });
});
