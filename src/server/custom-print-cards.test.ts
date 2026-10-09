import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createCard, deleteCard, getCard, listCards, patchCard, publishCard, processCustomCardJobs,
  isOwnedReferencePath, unsupportedClaims, type CardRow, type CustomCardDeps,
} from "./custom-print-cards.server";

const LOC_A = "11111111-1111-4111-8111-111111111111";
const LOC_B = "22222222-2222-4222-8222-222222222222";
const DEV = "33333333-3333-4333-8333-333333333333";
const OTHER_DEV = "44444444-4444-4444-8444-444444444444";
const OP = "55555555-5555-4555-8555-555555555555";
const REF = `2026-10-07/${DEV}/66666666-6666-4666-8666-666666666666.jpg`;

function fake(opts: { roles?: Record<string, string[]>; access?: Record<string, string[]>; publishThrows?: boolean; denyAi?: string[] } = {}) {
  const rows = new Map<string, CardRow>();
  let n = 0;
  const now = () => new Date(1_700_000_000_000 + n++ * 1000).toISOString();
  const deps: CustomCardDeps = {
    roles: async (u) => opts.roles?.[u] ?? [],
    canAccess: async (u, l) => (opts.roles?.[u] ?? []).includes("super_admin") || (opts.access?.[u] ?? []).includes(l),
    list: async ({ state, location_id }) => [...rows.values()].filter((r) => r.state === state && (state === "preset" || r.location_id === location_id)),
    get: async (id) => rows.get(id) ?? null,
    insertIdempotent: async (row) => {
      const hit = [...rows.values()].find((r) => r.created_by === row.created_by && r.client_op_id === row.client_op_id);
      if (hit) return { card: hit, created: false };
      const id = crypto.randomUUID();
      const t = now();
      const card: CardRow = { ...row, id, content: null, state: "custom", status: "queued", error: null, version: 1, created_at: t, updated_at: t };
      rows.set(id, card);
      return { card, created: true };
    },
    updateCas: async (id, v, patch, requireState) => {
      const r = rows.get(id);
      if (!r || r.version !== v || (requireState && r.state !== requireState)) return null;
      const next = { ...r, ...patch, version: r.version + 1, updated_at: now() };
      rows.set(id, next);
      return next;
    },
    deleteCas: async (id, v) => {
      const r = rows.get(id);
      if (!r || r.version !== v) return false;
      rows.delete(id);
      return true;
    },
    claim: async (limit) => {
      const out = [...rows.values()].filter((r) => r.status === "queued").slice(0, limit);
      return out.map((r) => {
        const c = { ...r, status: "processing" as const, job_token: crypto.randomUUID() };
        rows.set(r.id, c);
        return c;
      });
    },
    finish: async (id, token, v, patch) => {
      const r = rows.get(id);
      if (!r || r.job_token !== token || r.version !== v) return false;
      rows.set(id, { ...r, ...patch, job_token: null, version: r.version + 1, updated_at: now() });
      return true;
    },
    loadReference: async () => ({ mime: "image/jpeg", b64: "AAAA" }),
    verifyReference: async () => true,
    aiAllowed: async (u, v) => !!u && v === "2026-10-09-v1" && !(opts.denyAi ?? []).includes(u),
    generate: async () => ({ title: "卡通袜子", headline: "可爱图案每天好心情", body: "柔软舒适的卡通图案袜子，搭配日常穿搭更添趣味。" }),
  };
  if (opts.publishThrows) {
    const orig = deps.updateCas;
    deps.updateCas = async (id, v, patch, s) => {
      if (patch.state === "preset") throw new Error("db down");
      return orig(id, v, patch, s);
    };
  }
  return { deps, rows };
}

const staff = { userId: "staff", deviceId: DEV };
const hq = { userId: "hq", deviceId: DEV };
const admin = { userId: "admin", deviceId: DEV };
const env = () => fake({ roles: { hq: ["hq_operator"], admin: ["super_admin"], staff: ["store_staff"] }, access: { staff: [LOC_A], hq: [LOC_A, LOC_B] } });
const body = { location_id: LOC_A, client_op_id: OP, topic: "卡通袜子", instructions: "", formats: ["portrait", "landscape"] };

async function readyCard(deps: CustomCardDeps) {
  const c = await createCard(deps, staff, body);
  assert.equal(c.status, 202);
  await processCustomCardJobs(deps, 5);
  return (await getCard(deps, staff, (c as any).body.id, LOC_A) as any).body;
}

describe("custom print cards", () => {
  test("store staff cannot read or create in an unauthorized location", async () => {
    const { deps } = env();
    assert.equal((await createCard(deps, staff, { ...body, location_id: LOC_B })).status, 403);
    assert.equal((await listCards(deps, staff, { location_id: LOC_B, state: "custom" })).status, 403);
    const card = await readyCard(deps);
    // HQ authorized for B cannot see A's card through B
    assert.equal((await getCard(deps, hq, card.id, LOC_B)).status, 404);
    assert.equal((await patchCard(deps, hq, card.id, { location_id: LOC_B, expected_version: card.version, topic: "x" })).status, 404);
  });

  test("create is idempotent on client_op_id and conflicts on different payload", async () => {
    const { deps, rows } = env();
    const a = await createCard(deps, staff, body);
    const b = await createCard(deps, staff, body);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal((a as any).body.id, (b as any).body.id);
    assert.equal(rows.size, 1);
    assert.equal((await createCard(deps, staff, { ...body, topic: "别的" })).status, 409);
  });

  test("reference image must be uploaded by the current device", async () => {
    const { deps } = env();
    assert.ok(isOwnedReferencePath(REF, DEV));
    assert.ok(!isOwnedReferencePath(REF, OTHER_DEV));
    assert.ok(!isOwnedReferencePath("https://evil.test/a.jpg", DEV));
    assert.ok(!isOwnedReferencePath(`../${REF}`, DEV));
    assert.equal((await createCard(deps, { userId: "staff", deviceId: OTHER_DEV }, { ...body, reference_image_path: REF })).status, 403);
    assert.equal((await createCard(deps, staff, { ...body, reference_image_path: REF })).status, 202);
  });

  test("real generation errors are kept with a safe message and retry via regenerate", async () => {
    const { deps, rows } = env();
    deps.generate = async () => { throw new Error("AI gateway 500 https://secret.example/?token=abc"); };
    const c = (await createCard(deps, staff, body) as any).body;
    await processCustomCardJobs(deps, 5);
    const failed = rows.get(c.id)!;
    assert.equal(failed.status, "failed");
    assert.ok(failed.error && !/token|https?:/.test(failed.error));
    deps.generate = async () => ({ title: "卡通袜子", headline: "好心情", body: "卡通图案袜子。" });
    const r = await patchCard(deps, staff, c.id, { location_id: LOC_A, expected_version: failed.version, regenerate: true });
    assert.equal(r.status, 200);
    await processCustomCardJobs(deps, 5);
    assert.equal(rows.get(c.id)!.status, "ready");
  });

  test("reference image load failure marks failed without leaking", async () => {
    const { deps, rows } = env();
    deps.loadReference = async () => { throw new Error("storage 404 sku-raw/path"); };
    const c = (await createCard(deps, staff, { ...body, reference_image_path: REF }) as any).body;
    await processCustomCardJobs(deps, 5);
    assert.equal(rows.get(c.id)!.status, "failed");
    assert.ok(!rows.get(c.id)!.error!.includes("sku-raw"));
  });

  test("fabricated brand/year/material/rarity claims are rejected", async () => {
    assert.deepEqual(unsupportedClaims({ title: "卡通袜子", headline: "好心情", body: "柔软图案" }, "卡通袜子"), []);
    assert.ok(unsupportedClaims({ title: "1985年限量", headline: "纯棉", body: "稀有孤品" }, "卡通袜子").length >= 3);
    assert.deepEqual(unsupportedClaims({ title: "纯棉袜子", headline: "", body: "" }, "纯棉卡通袜子"), []);
    const { deps, rows } = env();
    deps.generate = async () => ({ title: "Nike正品", headline: "1990年代绝版", body: "真皮" });
    const c = (await createCard(deps, staff, body) as any).body;
    await processCustomCardJobs(deps, 5);
    assert.equal(rows.get(c.id)!.status, "failed");
    assert.equal(rows.get(c.id)!.content, null);
  });

  test("content edits enforce limits and do not force regeneration", async () => {
    const { deps } = env();
    const card = await readyCard(deps);
    const tooLong = await patchCard(deps, staff, card.id, { location_id: LOC_A, expected_version: card.version, content: { title: "字".repeat(19), headline: "好", body: "好" } });
    assert.equal(tooLong.status, 422);
    const ok = await patchCard(deps, staff, card.id, { location_id: LOC_A, expected_version: card.version, content: { title: " 袜子 ", headline: "好", body: "好" } });
    assert.equal(ok.status, 200);
    assert.equal((ok as any).body.status, "ready");
    assert.equal((ok as any).body.content.title, "袜子");
  });

  test("stale expected_version returns 409", async () => {
    const { deps } = env();
    const card = await readyCard(deps);
    assert.equal((await patchCard(deps, staff, card.id, { location_id: LOC_A, expected_version: card.version - 1, topic: "x" })).status, 409);
    assert.equal((await deleteCard(deps, staff, card.id, { location_id: LOC_A, expected_version: card.version + 5 })).status, 409);
    assert.equal((await publishCard(deps, admin, card.id, { location_id: LOC_A, expected_version: card.version + 5 })).status, 409);
  });

  test("only super_admin may publish; staff and HQ operator get 403", async () => {
    const { deps } = env();
    const card = await readyCard(deps);
    assert.equal((await publishCard(deps, staff, card.id, { location_id: LOC_A, expected_version: card.version })).status, 403);
    assert.equal((await publishCard(deps, hq, card.id, { location_id: LOC_A, expected_version: card.version })).status, 403);
    const r = await publishCard(deps, admin, card.id, { location_id: LOC_A, expected_version: card.version });
    assert.equal(r.status, 200);
    const again = await publishCard(deps, admin, card.id, { location_id: LOC_A, expected_version: card.version });
    assert.equal(again.status, 200);
    assert.equal((again as any).body.id, card.id);
    const custom = await listCards(deps, staff, { location_id: LOC_A, state: "custom" });
    const preset = await listCards(deps, hq, { location_id: LOC_B, state: "preset" });
    assert.equal((custom as any).body.cards.length, 0);
    assert.equal((preset as any).body.cards[0].id, card.id);
    assert.equal((preset as any).body.can_publish, false);
    // preset edit/delete only super_admin
    const v = (r as any).body.version;
    assert.equal((await patchCard(deps, staff, card.id, { location_id: LOC_A, expected_version: v, topic: "x" })).status, 403);
    assert.equal((await deleteCard(deps, hq, card.id, { location_id: LOC_A, expected_version: v })).status, 403);
  });

  test("publish failure keeps the original custom record", async () => {
    const f = fake({ roles: { admin: ["super_admin"], staff: ["store_staff"] }, access: { staff: [LOC_A] }, publishThrows: true });
    const card = await readyCard(f.deps);
    await assert.rejects(publishCard(f.deps, admin, card.id, { location_id: LOC_A, expected_version: card.version }));
    const after = f.rows.get(card.id)!;
    assert.equal(after.state, "custom");
    assert.equal(after.version, card.version);
  });

  test("not-ready cards cannot be published", async () => {
    const { deps } = env();
    const c = (await createCard(deps, staff, body) as any).body;
    assert.equal((await publishCard(deps, admin, c.id, { location_id: LOC_A, expected_version: c.version })).status, 409);
  });

  test("edit during processing discards the stale worker result", async () => {
    const { deps, rows } = env();
    const c = (await createCard(deps, staff, body) as any).body;
    let release!: () => void;
    deps.generate = async () => { await new Promise<void>((r) => (release = r)); return { title: "旧", headline: "好", body: "好" }; };
    const run = processCustomCardJobs(deps, 5);
    await new Promise((r) => setTimeout(r, 5));
    const cur = rows.get(c.id)!;
    await patchCard(deps, staff, c.id, { location_id: LOC_A, expected_version: cur.version, content: { title: "人工", headline: "好", body: "好" } });
    release();
    await run;
    assert.equal(rows.get(c.id)!.content!.title, "人工");
  });

  test("worker rejects empty, whitespace-only and over-long content; edits too", async () => {
    for (const bad of [
      { title: "袜子", headline: "", body: "好" },
      { title: "袜子", headline: "   ", body: "好" },
      { title: " ", headline: "好", body: "好" },
      { title: "袜子", headline: "好", body: "字".repeat(91) },
      { title: "袜子", headline: "字".repeat(21), body: "好" },
    ]) {
      const { deps, rows } = env();
      deps.generate = async () => bad;
      const c = (await createCard(deps, staff, body) as any).body;
      await processCustomCardJobs(deps, 1);
      assert.equal(rows.get(c.id)!.status, "failed", JSON.stringify(bad));
      assert.equal(rows.get(c.id)!.content, null);
    }
    const { deps } = env();
    const card = await readyCard(deps);
    const r = await patchCard(deps, staff, card.id, { location_id: LOC_A, expected_version: card.version, content: { title: "袜子", headline: "  ", body: "好" } });
    assert.equal(r.status, 422);
  });

  test("worker claims one card at a time so unstarted cards hold no lease", async () => {
    const { deps } = env();
    for (let i = 0; i < 3; i++) await createCard(deps, staff, { ...body, client_op_id: crypto.randomUUID() });
    const orig = deps.claim;
    const sizes: number[] = [];
    let inFlight = 0, claimedWhileBusy = 0;
    deps.claim = async (n) => { sizes.push(n); if (inFlight) claimedWhileBusy++; return orig(n); };
    const gen = deps.generate;
    deps.generate = async (i) => { inFlight++; await new Promise((r) => setTimeout(r, 2)); inFlight--; return gen(i); };
    const res = await processCustomCardJobs(deps, 6);
    assert.deepEqual(sizes, [1, 1, 1, 1]);
    assert.equal(claimedWhileBusy, 0);
    assert.equal(res.ready, 3);
    const two = env();
    for (let i = 0; i < 3; i++) await createCard(two.deps, staff, { ...body, client_op_id: crypto.randomUUID() });
    assert.equal((await processCustomCardJobs(two.deps, 2)).claimed, 2);
  });

  test("reference must exist and be a real image", async () => {
    const { deps } = env();
    deps.verifyReference = async () => false;
    assert.equal((await createCard(deps, staff, { ...body, reference_image_path: REF })).status, 422);
  });
});

describe("custom print cards AI consent", () => {
  test("create without consent is 403 and nothing is queued", async () => {
    const f = fake({ access: { staff: [LOC_A] }, denyAi: ["staff"] });
    const r = await createCard(f.deps, staff, body);
    assert.equal((r as any).code, "ai_consent_required");
    assert.equal(f.rows.size, 0);
  });
  test("consent revoked after enqueue: worker fails the card without calling AI", async () => {
    const deny: string[] = [];
    const f = fake({ access: { staff: [LOC_A] }, denyAi: deny });
    let calls = 0;
    const gen = f.deps.generate;
    f.deps.generate = async (i) => { calls++; return gen(i); };
    const c = await createCard(f.deps, staff, body);
    assert.equal(c.status, 202);
    const row = [...f.rows.values()][0];
    assert.equal(row.ai_actor_user_id, "staff");
    assert.equal(row.ai_policy_version, "2026-10-09-v1");
    deny.push("staff");
    const out = await processCustomCardJobs(f.deps, 2);
    assert.equal(out.failed, 1);
    assert.equal(calls, 0);
    assert.match([...f.rows.values()][0].error ?? "", /授权/);
  });
  test("manual content patch is never blocked by missing consent", async () => {
    const deny: string[] = [];
    const f = fake({ access: { staff: [LOC_A] }, denyAi: deny });
    const c: any = await createCard(f.deps, staff, body);
    deny.push("staff");
    const p = await patchCard(f.deps, staff, c.body.id, { location_id: LOC_A, expected_version: c.body.version,
      content: { title: "手写标题", headline: "手写短句", body: "手写正文内容" } });
    assert.equal(p.status, 200);
    const regen = await patchCard(f.deps, staff, c.body.id, { location_id: LOC_A, expected_version: (p as any).body.version, regenerate: true });
    assert.equal((regen as any).code, "ai_consent_required");
  });
});
