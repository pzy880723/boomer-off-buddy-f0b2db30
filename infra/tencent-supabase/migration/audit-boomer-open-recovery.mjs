import pg from "pg";
import { transformBoomerOpenSnapshot } from "./boomer-open-transform.mjs";

const response = await fetch(`${process.env.BOOMER_OPEN_BASE_URL}/api/bootstrap`, {
  headers: { "x-boomer-token": process.env.BOOMER_OPEN_APP_TOKEN },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Bootstrap HTTP ${response.status}`);
const snapshot = await response.json();
const transformed = transformBoomerOpenSnapshot(snapshot, {
  bucket: process.env.BOOMER_OPEN_COS_BUCKET,
  region: process.env.BOOMER_OPEN_COS_REGION,
});
const projects = new Set(transformed.projects.map(p => p.legacyId));
const missing = transformed.attachments.filter(a => !projects.has(a.projectLegacyId));
const pool = new pg.Pool({ connectionString: process.env.TARGET_DATABASE_URL, ssl: false });
try {
  const rows = await pool.query("select legacy_id, status from public.store_development_projects where legacy_id = any($1::text[])", [[...new Set(missing.map(a => a.projectLegacyId))]]);
  console.log(JSON.stringify({
    sourceProjects: projects.size,
    orphanAttachments: missing.length,
    missingProjectIds: [...new Set(missing.map(a => a.projectLegacyId))],
    existingProjects: rows.rows,
    orphanAttachmentKeys: missing.map(a => ({ id: a.legacyId, keys: Object.keys(snapshot.attachments.find(x => String(x.id) === a.legacyId) ?? {}) })),
    missingCosts: transformed.costs.filter(c => !projects.has(c.projectLegacyId)).length,
  }));
} finally { await pool.end(); }
