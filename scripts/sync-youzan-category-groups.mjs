#!/usr/bin/env node

const execute = process.argv.includes("--execute");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const endpoint =
  process.env.ERP_CATEGORY_GROUP_SYNC_URL ??
  "https://erp.boomeroff.com/api/public/hooks/youzan-category-groups-sync";

if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

const categoryCodes = String(process.env.CATEGORY_GROUP_CODES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const channels = String(process.env.CATEGORY_GROUP_CHANNELS ?? "0,1")
  .split(",")
  .map(Number)
  .filter((value) => value === 0 || value === 1);

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    dry_run: !execute,
    confirm: execute ? "SYNC_ERP_CATEGORIES_TO_YOUZAN_GROUPS" : "",
    category_codes: categoryCodes,
    channels,
    max_items: Number(process.env.CATEGORY_GROUP_MAX_ITEMS ?? 10_000),
  }),
});
const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  throw new Error(`category group sync returned non-JSON (${response.status}): ${text.slice(0, 500)}`);
}
console.log(JSON.stringify(payload, null, 2));
if (!response.ok || payload.ok !== true) process.exitCode = 1;
