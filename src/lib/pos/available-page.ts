/** Fill a visible page only after the authoritative reservation-aware stock check. */
export async function collectPosAvailablePage<T>(
  offset: number,
  loadPage: (offset: number, size: number) => Promise<T[]>,
  available: (row: T) => Promise<number>,
): Promise<{ items: Array<{ row: T; qty: number }>; next_offset: number | null }> {
  const items: Array<{ row: T; qty: number }> = [];
  const pageSize = 24;
  let cursor = offset;
  // Bound request work; clients may continue if many goods have reservations.
  for (let page = 0; page < 5; page++) {
    const rows = await loadPage(cursor, pageSize);
    if (!rows.length) return { items, next_offset: null };
    const quantities: number[] = [];
    for (let i = 0; i < rows.length; i += 6) {
      quantities.push(...(await Promise.all(rows.slice(i, i + 6).map(available))));
    }
    for (let index = 0; index < rows.length; index++) {
      cursor++;
      if (quantities[index] > 0) items.push({ row: rows[index], qty: quantities[index] });
      if (items.length === pageSize) {
        const exhausted = rows.length < pageSize && index === rows.length - 1;
        return { items, next_offset: exhausted ? null : cursor };
      }
    }
    if (rows.length < pageSize) return { items, next_offset: null };
  }
  return { items, next_offset: cursor };
}
