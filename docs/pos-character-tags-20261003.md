# POS character tags

## Scope

- Keep company/manufacturer brands distinct from specific IP characters.
- Add a third optional compact row before price tiers: type, brand, IP/character.
- Use active `inv_facets` character records, not a second taxonomy table.
- Seed 31 Sanrio and 48 Disney/Pixar characters, retaining existing IDs and disabled states. Together with other existing characters, production has 83 active character choices.
- All character names are accessible in the horizontal row and searchable chooser. Selecting a brand prioritizes related names without blocking licensed merchandise from other manufacturers.
- Character IDs and canonical name snapshots survive cart grouping, hold/resume, cash sales, WeChat/Alipay payment attempts and receipts. Selecting a character does not modify a shared standard SKU.
- This stores purchase-line metadata for later customer preference analysis; it does not automatically infer or change customer profile preferences.

## Catalog Sources

- https://www.sanrio.com/pages/character-goodies
- https://www.sanrio.co.jp/characters/
- https://store.disney.co.jp/characters-list.html

This is a concrete selectable catalog, not a claim to include every historical character ever created. Chinese and English aliases support lookup; new active character facets are returned by the existing catalog API.

## Verification

- 184 tests passed: POS catalog, cart/held metadata, isolated PostgreSQL/PGlite sales/points/replay/refunds, payment preflight rejection and provider payload preservation.
- `npx tsc --noEmit` and `git diff --check` passed.
- Local real POS component with isolated API fixtures: Hello Kitty and Kuromi at the same 12.9 price remain separate, hold/resume preserves both, Donald alias finds 唐老鸭.
- 390px viewport with all three rows: document width 390px, row heights 46/45/45px, no document horizontal overflow. Desktop screenshot reviewed.
- No production sale, payment, return, stock adjustment or customer-profile mutation performed.

## Database

- Migration: `20261003121301_pos_character_tags.sql`.
- Applied directly via connected Lovable database connector after a transaction/ROLLBACK dry run. First commit attempt hit a 5s lock timeout and rolled back; after the schema-dump read lock cleared, retry succeeded.
- Live verification: 83 active characters, four new columns across order/held items; core function body MD5 `95a45b1c8d363514cf44dfd1449493b6`.
- Only verified function baselines are patched; no ACL changes. Old clients remain compatible with nullable character metadata.
- Lovable notified directly (`umsg_01m40vam6wf0jrxnwm8n51etgh`), including avoiding duplicate execution and reconciling migration history separately.

## Release

- Code commit: `a3c9450`, pushed to GitHub main and codex/pos-checkout-density.
- Tencent candidate: `/var/www/boomer-erp/releases/pos-characters-a3c9450-20261003`.
- Previous production retained: `/var/www/boomer-erp/releases/pos-brands-bd2cb22-20261003`.
- Candidate and public production verification passed, asset `index-CCH8hMu1.js` matched the built artifact. Login hydration and worker guards passed; POS endpoints still reject unauthenticated calls with 401.
- Tencent current switched to the candidate above; previous release retained. Deployment script does not apply SQL (migration was applied separately as documented).
- Authenticated production UI verified 14 categories, 83 character buttons plus skip/search controls. Sanrio prioritizes Hello Kitty/Kuromi/My Melody/Cinnamoroll; Disney prioritizes Mickey/Minnie/Donald/Daisy. All three optional rows appear before prices.
- Production cart remained empty; no prices or payment actions were clicked. Brand/character selections reset after verification.
- Rollback: use the existing scoped deployment script with the previous/new release paths and `rollback`; leave additive nullable DB columns intact for backward compatibility.
