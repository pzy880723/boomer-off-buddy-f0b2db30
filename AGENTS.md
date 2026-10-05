# Architecture rules
- Youzan push callbacks: when the Event-Sign header is present, verify MD5(client_id + raw HTTP body + client_secret) only, with no fallback to body.sign. Header-less legacy body.sign messages are read-only hints and stay blocked. Why: only the raw body is covered by the current official signature.
- Youzan member-asset notifications only trigger read-only re-queries into youzan_member_asset_observations. They never write wallets, coupons or the points ledger. Why: the outer fields are unsigned and the ERP is the single ledger.
