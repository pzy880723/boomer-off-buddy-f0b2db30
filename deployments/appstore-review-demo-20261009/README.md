# App Store review demo instance (manual)

- Same production iPhone app; backend runs with `BOOMER_REVIEW_ISOLATED=true` against an independent database.
- Start-up gate `scripts/assert-review-isolation.mjs` (called by `run-tencent-erp.sh`) refuses to boot when the
  database points at production (Lovable Cloud ref / data.boomeroff.top), required independent keys are missing,
  or any Youzan / payment / SMS / Tencent media / GO channel or background writer is configured.
- Runtime: `youzanFetch`, Tencent SMS, WeChat Pay client throw `review_isolation_violation`; POS WeChat/Alipay report not configured.
- `auth/bootstrap` issues `rvw_` device tokens and returns `environment: "demo"`; production output is unchanged.
- `seed.sql`: run once by hand after creating the two demo accounts via the new instance Auth admin API.
  It refuses non-empty/production-looking databases. Not a migration.
- AI consent guards are unchanged; demo staff must still grant consent in-app before AI features work.
