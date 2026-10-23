// Stable bounded identity traversal, not a transaction snapshot of mutable statuses.
export async function traverseMemberKeyset<T>(source: {
  upperBound(): Promise<string|null>;
  page(after: string|null, upper: string, limit: number): Promise<T[]>;
  key(row: T): string;
  visit(row: T): Promise<void>;
}, maxPages = 1000): Promise<void> {
  const upper = await source.upperBound();
  if (upper === null) return;
  let after: string|null = null;
  for (let page = 0; page < maxPages; page++) {
    const rows = await source.page(after, upper, 100);
    if (rows.length > 100) throw Error('member_keyset_invalid_page');
    for (const row of rows) {
      const key = source.key(row);
      if (!key || key > upper || (after !== null && key <= after)) throw Error('member_keyset_nonprogress');
      after = key;
      await source.visit(row);
    }
    if (rows.length < 100 || after === upper) return;
  }
  throw Error('member_keyset_limit');
}