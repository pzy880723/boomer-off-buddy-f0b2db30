// PostgREST puts the IN filter in the URL; hundreds of UUIDs overflow proxy headers.
export async function readSkuBatches<T>(
  ids: string[],
  read: (batch: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const result = await read(ids.slice(offset, offset + 100));
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
  }
  return rows;
}
