export function getSmartCreateReleaseTarget(input: {
  autoPushYouzan: boolean;
  locationKind: string;
  shopId: string | null | undefined;
}): string | null {
  if (!input.autoPushYouzan) return null;
  if (input.locationKind !== "shop") return null;
  return input.shopId?.trim() || null;
}
