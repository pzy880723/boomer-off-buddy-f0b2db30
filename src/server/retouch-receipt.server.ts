/** Called only after the unchanged generation + quality gates and successful upload. */
export async function recordValidatedRetouch(
  output: { preserved_original?: boolean },
  write: () => Promise<{ error: unknown }>,
): Promise<void> {
  if (output.preserved_original === true) return;
  const { error } = await write();
  if (error) throw new Error("retouch_receipt_unavailable");
}