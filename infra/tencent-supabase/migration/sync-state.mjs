import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function snapshotDigest(snapshot) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

export async function readSyncState(path) {
  if (!path) return null;
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeSyncState(path, digest) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  await writeFile(temporary, `${digest}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
