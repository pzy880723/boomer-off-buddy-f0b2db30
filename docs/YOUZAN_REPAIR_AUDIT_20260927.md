# Read-Only Repair Verification

New standalone scripts only. No deployment, DB writes, remote product mutation,
stock adjustment, token refresh or whole-catalog scan. Run remote reads on the
authorized fixed-egress host; the aggregator itself works offline.

## Final Active-Branch Scope

```sh
node --env-file=.env scripts/audit-youzan-branch-visibility.mjs \
  --audit /tmp/youzan-custom-audit-before-20260927-v2.jsonl --affected10 \
  > /tmp/youzan-branches-final-20260927.json
```

`--affected10` contains the approved ten UUIDs, including the canary and both
stock repairs. Alternatively repeat `--sku UUID` (1..13 distinct IDs). The
script reuses verified master codes from the supplied audit and existing HQ
token, performs two DB GETs, then one `itemdetail.get` per selected SKU per
active configured branch. With three active branches this is 30 detail calls.
It refuses more than 200 detail calls. Unknown/error responses are never
treated as absent; exact upstream not-found codes are required.

Do not call `/tmp/youzan-branches-scope-check-20260927.json` an untouched
before baseline: canary and other image writes were already underway when it
was collected, and KORG was still visible in the other two stores.

## Offline Aggregation

```sh
node scripts/verify-youzan-repair-audit.mjs \
  /tmp/youzan-custom-audit-before-20260927-v2.jsonl FINAL_AUDIT.jsonl \
  --branches-before /tmp/youzan-branches-scope-check-20260927.json \
  --branches-after /tmp/youzan-branches-final-20260927.json \
  > /tmp/youzan-repair-verification-20260927.json
```

Final product audit must cover exactly the same SKU set as before-v2, not just
the canary. Only these deltas are approved:

- Kitty `18ace324-fbd1-4c8e-8dcd-12f01329a99e` and KORG
  `fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3`: Xintiandi `212291308` WMS 0 to 1,
  corresponding channel stock 0 to 1; ERP quantity remains 1, reserved/sold 0.
- Kitty target `item_barcode`: `P260927306036196` to `2006890664290`.
- KORG other-store channel presence: present to absent. Other nine products
  remain absent outside Xintiandi. All ten remain visible at Xintiandi.

Comparison covers stable product/channel identity, ERP/master/POS prices,
barcodes, ERP/WMS quantities (including freeze/road/plan where returned),
sold counts and store visibility. Images are intentionally outside this
comparator; pixel matching remains a separate audit. WMS `stock_num` is in
whole units. Channel SKU `stock_num_str` takes precedence; raw channel
`stock_num` is divided by 1000. POS prices use `skus[].price` in cents.

Missing rows, duplicates, incomplete numeric evidence and unknown reads fail.
Exit 0 means the comparisons passed, 1 means discrepancy, and 2 means invalid
aggregator input/arguments. Always review `warnings`: before-v2 has no HQ
detail, the initial scope-check has no channel stock, and a removed channel
cannot prove its later hidden warehouse stock/price. None is reported as
verified invariance. Final all-branch scope must include all ten IDs. Without
both branch files, the report explicitly says all-store invariance is unproven.

## Tests

```sh
node --test scripts/verify-youzan-repair-audit.test.mjs \
  scripts/audit-youzan-branch-visibility.test.mjs
```

All fixtures/API responses are local or mocked. No live repair is performed.
