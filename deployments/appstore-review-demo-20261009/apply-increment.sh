#!/bin/bash
# Apply schema-increment.manifest to the App Store review DEMO database only.
#   REVIEW_DATABASE_URL=postgresql://... BOOMER_REVIEW_ISOLATED=true bash apply-increment.sh [--dry-run]
# Each file runs in its own transaction; applied files are recorded in review_demo.schema_log so re-runs skip them.
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE=deployments/appstore-review-demo-20261009
MANIFEST=$HERE/schema-increment.manifest
DRY=${1:-}

[[ "${BOOMER_REVIEW_ISOLATED:-}" == "true" ]] || { echo "refuse: BOOMER_REVIEW_ISOLATED must be true" >&2; exit 2; }
URL=${REVIEW_DATABASE_URL:-}
[[ -n "$URL" ]] || { echo "refuse: REVIEW_DATABASE_URL is required" >&2; exit 2; }
for marker in sxddfcoiaboqcmeviykl data.boomeroff.top supabase.co supabase.com; do
  [[ "$URL" != *"$marker"* ]] || { echo "refuse: REVIEW_DATABASE_URL points at a production/hosted database" >&2; exit 2; }
done
PSQL=(psql "$URL" -X -q -v ON_ERROR_STOP=1)

# Target sanity: a demo instance at the 20260731070000 baseline with no real business data.
"${PSQL[@]}" -At <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM auth.users) > 10 THEN RAISE EXCEPTION 'refuse: too many auth users for a demo instance'; END IF;
  IF to_regclass('public.inv_skus') IS NULL OR to_regclass('public.store_development_projects') IS NULL THEN
    RAISE EXCEPTION 'refuse: target is not at the 20260731070000 baseline';
  END IF;
  IF EXISTS (SELECT 1 FROM public.youzan_shops) OR EXISTS (SELECT 1 FROM public.commerce_customers)
     OR EXISTS (SELECT 1 FROM public.commerce_orders WHERE coalesce(metadata->>'demo','') <> 'true') THEN
    RAISE EXCEPTION 'refuse: target contains real business data';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS review_demo;
CREATE TABLE IF NOT EXISTS review_demo.schema_log (file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON SCHEMA review_demo FROM PUBLIC;
SQL

applied=0; skipped=0
while read -r action path _; do
  [[ -z "${action:-}" || "$action" == \#* ]] && continue
  if [[ "$action" == skip ]]; then echo "SKIP  $path"; skipped=$((skipped+1)); continue; fi
  [[ "$action" == apply ]] || { echo "bad manifest line: $action" >&2; exit 3; }
  [[ -f "$path" ]] || { echo "missing file: $path" >&2; exit 3; }
  sum=$(sha256sum "$path" | cut -d' ' -f1)
  done_sum=$("${PSQL[@]}" -At -c "select sha256 from review_demo.schema_log where file = '$path'")
  if [[ -n "$done_sum" ]]; then
    [[ "$done_sum" == "$sum" ]] || { echo "changed after apply: $path" >&2; exit 4; }
    continue
  fi
  if [[ "$DRY" == --dry-run ]]; then echo "WOULD $path"; continue; fi
  { cat "$path"; printf "\nINSERT INTO review_demo.schema_log(file, sha256) VALUES ('%s', '%s');\n" "$path" "$sum"; } \
    | "${PSQL[@]}" -1 -f - >/dev/null || { echo "FAIL  $path" >&2; exit 1; }
  echo "OK    $path"; applied=$((applied+1))
done < "$MANIFEST"
echo "done: applied=$applied skipped=$skipped"
