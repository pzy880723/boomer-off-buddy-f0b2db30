type ImageJob = {status: string; source_bucket: string; source_path: string; target_path: string | null; updated_at: string};
export function resolveListingImageSources<T extends {image_paths: string[] | null; sku?: {image_jobs: ImageJob[]} | null}>(listing: T): T {
  const replacements = new Map<string, string>();
  const jobs = [...(listing.sku?.image_jobs ?? [])].sort((a,b)=>a.updated_at.localeCompare(b.updated_at));
  for (const job of jobs) {
    if (job.status !== 'succeeded' || job.source_bucket !== 'sku-raw' || !job.target_path) continue;
    replacements.set(`${job.source_bucket}/${job.source_path}`, `sku-listing/${job.target_path}`);
  }
  return {...listing, image_paths: listing.image_paths?.map(path=>replacements.get(path) ?? path) ?? null};
}
