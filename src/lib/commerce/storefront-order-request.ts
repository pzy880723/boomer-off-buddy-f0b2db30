export type StorefrontOrderItem = {
  listing_id: string;
  quantity: number;
};

export type StorefrontOrderItemsInput = {
  items?: StorefrontOrderItem[];
  listing_ids?: string[];
};

export function normalizeStorefrontOrderItems(
  input: StorefrontOrderItemsInput,
): StorefrontOrderItem[] {
  const items =
    input.items ??
    input.listing_ids?.map((listingId) => ({ listing_id: listingId, quantity: 1 })) ??
    [];

  if (items.length === 0) throw new Error("order requires at least one item");
  if (items.length > 50) throw new Error("order has too many items");

  const seen = new Set<string>();
  return items.map((item) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) {
      throw new Error("order item quantity is invalid");
    }
    if (seen.has(item.listing_id)) throw new Error("order contains duplicate listings");
    seen.add(item.listing_id);
    return { listing_id: item.listing_id, quantity: item.quantity };
  });
}
