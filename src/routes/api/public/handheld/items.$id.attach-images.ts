import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { AttachImagesReq } from "@/lib/handheld/schemas";

const SKU_IMAGE_BUCKETS = new Set(["sku-raw", "sku-listing"]);

function normalizeBucketPath(bucket: "sku-raw" | "sku-listing", storagePath: string): string | null {
  const clean = storagePath.trim().replace(/^\/+/, "");
  if (!clean) return null;
  if (clean.startsWith(`${bucket}/`)) return clean;
  return `${bucket}/${clean}`;
}

function parseStorageObjectUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const markers = [
      "/storage/v1/object/sign/",
      "/storage/v1/object/public/",
      "/storage/v1/object/authenticated/",
      "/storage/v1/object/upload/sign/",
    ];
    for (const marker of markers) {
      const idx = url.pathname.indexOf(marker);
      if (idx < 0) continue;
      const rest = url.pathname.slice(idx + marker.length).replace(/^\/+/, "");
      const parts = rest.split("/").map((part) => decodeURIComponent(part));
      const bucket = parts.shift();
      const path = parts.join("/");
      if (bucket && SKU_IMAGE_BUCKETS.has(bucket) && path) return `${bucket}/${path}`;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeIncomingImageUrl(imageUrl?: string | null): string | null {
  const raw = imageUrl?.trim();
  if (!raw) return null;
  const storagePath = parseStorageObjectUrl(raw);
  if (storagePath) return storagePath;
  if (/^https?:\/\//i.test(raw) && !raw.includes("token=")) return raw;
  return null;
}

export const Route = createFileRoute("/api/public/handheld/items/$id/attach-images")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: ReturnType<typeof AttachImagesReq.parse>;
        try {
          body = AttachImagesReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { code: "validation_error", detail: String(e) });
        }

        const { data: sku, error } = await supabaseAdmin
          .from("inv_skus")
          .select("id, image_url, image_paths")
          .eq("id", params.id)
          .maybeSingle();
        if (error) return err(error.message, 500, { code: "internal_error" });
        if (!sku) return err("SKU not found", 404, { code: "not_found" });

        const incomingPaths: string[] = [];
        for (const p of body.image_storage_paths ?? []) {
          const normalized = normalizeBucketPath(p.bucket, p.storage_path);
          if (normalized) incomingPaths.push(normalized);
        }
        const normalizedImageUrl = normalizeIncomingImageUrl(body.image_url);
        if (normalizedImageUrl) incomingPaths.push(normalizedImageUrl);

        const seen = new Set<string>();
        const merged: string[] = [];
        for (const p of [...(((sku as { image_paths?: string[] | null }).image_paths ?? []) as string[]), ...incomingPaths]) {
          if (!p || seen.has(p)) continue;
          seen.add(p);
          merged.push(p);
        }

        const stableHttp = merged.find((p) => /^https?:\/\//i.test(p) && !p.includes("token=")) ?? null;
        const { error: upErr } = await supabaseAdmin
          .from("inv_skus")
          .update({
            image_paths: merged,
            image_url: stableHttp ?? (sku as { image_url?: string | null }).image_url ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", params.id);
        if (upErr) return err(upErr.message, 500, { code: "internal_error" });

        const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
        const signedList = await signSkuImagePaths(merged);
        const images = merged
          .map((p, i) => (signedList[i] ? { storage_path: p, read_url: signedList[i]! } : null))
          .filter((x): x is { storage_path: string; read_url: string } => x !== null);

        return ok({
          sku_id: params.id,
          image_url: images[0]?.read_url ?? stableHttp,
          image_paths: merged,
          images,
        });
      },
    },
  },
});