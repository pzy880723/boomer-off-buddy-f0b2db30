import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state: any = {};
(globalThis as any).__productContent = state;
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": `export const supabaseAdmin = {
    rpc: async (name,args) => { const s=globalThis.__productContent; s.calls.push({name,args}); return s.rpc(name,args); },
    from: (table) => { const s=globalThis.__productContent; s.reads.push(table); const q={
      select: (columns) => { s.columns.push(columns); return q; }, eq:()=>q, in:()=>q,
      maybeSingle:async()=>({data:s.rows[table],error:null}),
      then:(r)=>Promise.resolve({data:s.rows[table],error:null}).then(r) }; return q; }
  };`,
  "@/server/handheld-auth.server": `export const resolveSessionUser=async()=>globalThis.__productContent.session;
    export const ok=data=>Response.json({ok:true,data});
    export const err=(error,status,extra)=>Response.json({ok:false,error,...extra},{status});`,
  "@/lib/sku-image-resolver.server": `export const signSkuImagePaths=async paths=>{
    const s=globalThis.__productContent; s.signed.push(...paths); if(s.signFail) throw new Error('storage'); return paths.map(()=>null);
  };`,
  "@/server/media-derivative.server": `export const DERIVATIVE_WIDTHS={preview:960};
    export const signDerivativeUrls=async(paths,width)=>{const s=globalThis.__productContent;
      s.derivatives.push({paths,width}); if(s.derivativeFail) throw new Error('render');
      return paths.map((_,i)=>s.derivativeUrls[i]??null);};`,
  "@/server/handheld-listing-image-jobs.server": `export const triggerListingImageWorker=()=>{globalThis.__productContent.triggers++;};`,
};
const bundle = await build({
  entryPoints: ["src/server/product-content.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "stubs",
      setup(b: any) {
        b.onResolve({ filter: /^@\// }, (a: any) =>
          stubs[a.path]
            ? { path: a.path, namespace: "stub" }
            : { path: resolve(a.path.replace(/^@\//, "src/") + ".ts") },
        );
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({
          contents: stubs[a.path],
          loader: "js",
        }));
      },
    },
  ],
});
const content = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const sku = "00000000-0000-4000-8000-000000000001";
const device = {
  id: "00000000-0000-4000-8000-000000000002",
  location_id: "00000000-0000-4000-8000-000000000003",
};
const image = { id: "raw", type: "image", storage_path: `sku-raw/2026-09-27/${device.id}/raw.jpg` };
const request = (body: unknown) =>
  new Request("http://local/content", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  Object.assign(state, {
    calls: [],
    reads: [],
    columns: [],
    signed: [],
    derivatives: [],
    derivativeUrls: [],
    derivativeFail: false,
    triggers: 0,
    signFail: false,
    session: { user_id: "employee" },
    rpc: () => ({ data: { version: 0, draft_blocks: [image], published_blocks: [] }, error: null }),
    rows: {
      inv_skus: {
        name: "Porcelain cup",
        category: "cup",
        grade: "A",
        weight_g: 100,
        attributes: { era: "copyright 1974", functional_status: "untested" },
        brand_candidate_text: "UNCONFIRMED",
      },
    },
  });
});
test("all actions require an employee before RPC or signing", async () => {
  state.session = null;
  for (const action of ["get", "save", "generate"]) {
    assert.equal(
      (await content.handleProductContent(request({ action }), device, sku)).status,
      401,
    );
  }
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.signed, []);
});
for (const action of ["get", "save", "generate"])
  test(`${action} authorizes in SQL before metadata, AI or signing`, async () => {
    state.rpc = () => ({ error: { message: "edit_forbidden" } });
    const res = await content.handleProductContent(
      request({
        action,
        ...(action === "save"
          ? { blocks: [image], expected_version: 0, client_op_id: "save-0001" }
          : {}),
      }),
      device,
      sku,
    );
    assert.equal(res.status, 403);
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.signed, []);
  });
test("get preserves raw references and IDs when storage signing fails", async () => {
  state.signFail = true;
  const res = await content.handleProductContent(request({ action: "get" }), device, sku);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.draft_blocks, [{ ...image, read_url: null }]);
});
test("save forwards the immutable body and maps both conflicts to 409", async () => {
  const body = {
    action: "save",
    expected_version: 0,
    client_op_id: "save-0001",
    blocks: [image],
    publish: true,
  };
  for (const code of ["version_conflict", "client_op_id_conflict"]) {
    state.rpc = () => ({ error: { message: code, details: "3" } });
    const res = await content.handleProductContent(request(body), device, sku);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, code);
    assert.deepEqual(state.calls.at(-1).args.p_request, body);
  }
});
test("generate uses confirmed persisted metadata, returns a preview and never saves", async () => {
  const previous = globalThis.fetch;
  const key = process.env.LOVABLE_API_KEY;
  process.env.LOVABLE_API_KEY = "test";
  let sent: any;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://ai.gateway.lovable.dev/v1/chat/completions");
    sent = JSON.parse(String(init.body));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              blocks: [{ type: "paragraph", text: "A quiet moment at your desk." }],
            }),
          },
        },
      ],
    });
  }) as typeof fetch;
  try {
    const res = await content.handleProductContent(request({ action: "generate" }), device, sku);
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.equal(data.version, 0);
    assert.deepEqual(data.published_blocks, []);
    assert.ok(
      data.blocks.some((b: any) => b.id === image.id && b.storage_path === image.storage_path),
    );
    assert.equal(state.calls.length, 1);
    assert.match(sent.messages[1].content, /Porcelain cup/);
    assert.doesNotMatch(sent.messages[1].content, /copyright|1974|UNCONFIRMED|untested/);
    assert.match(sent.messages[0].content, /scarcity|年份|限量/);
  } finally {
    globalThis.fetch = previous;
    if (key === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = key;
  }
});
test("public helper uses a published-only RPC and never returns or signs drafts", async () => {
  state.rpc = (name: string) => {
    assert.equal(name, "published_product_content");
    return {
      data: {
        version: 1,
        published_blocks: [image],
        draft_blocks: [{ ...image, storage_path: "sku-raw/secret.jpg" }],
      },
    };
  };
  const data = await content.loadPublishedProductContent(sku);
  assert.deepEqual(Object.keys(data).sort(), ["published_blocks", "version"]);
  assert.deepEqual(state.signed, []);
  assert.deepEqual(state.derivatives, [{ paths: [image.storage_path], width: 960 }]);
});
test("public helper returns null for unpublished or hidden products without signing", async () => {
  state.rpc = () => ({ data: null });
  assert.equal(await content.loadPublishedProductContent(sku), null);
  assert.deepEqual(state.signed, []);
  assert.deepEqual(state.derivatives, []);
});

test("published images use aligned 960px derivatives, retaining failed blocks without raw fallback", async () => {
  const images = [image, { ...image, id: "second", storage_path: "sku-raw/second.jpg" }];
  state.rpc = () => ({ data: { version: 3, published_blocks: images } });
  state.derivativeUrls = [
    null,
    "https://example.test/storage/v1/render/image/sign/sku-raw/second.jpg?width=960",
  ];
  const result = await content.loadPublishedProductContent(sku);
  assert.deepEqual(
    result.published_blocks,
    images.map((block, i) => ({ ...block, read_url: state.derivativeUrls[i] })),
  );
  assert.deepEqual(state.signed, []);
  state.derivativeFail = true;
  assert.deepEqual(
    (await content.loadPublishedProductContent(sku)).published_blocks,
    images.map((block) => ({ ...block, read_url: null })),
  );
});

test("only a successful publish wakes the durable content image worker", async () => {
  for (const publish of [false, true]) {
    const response = await content.handleProductContent(
      request({
        action: "save",
        blocks: [image],
        expected_version: 0,
        client_op_id: "save-queue-01",
        publish,
      }),
      device,
      sku,
    );
    assert.equal(response.status, 200);
    assert.equal(state.triggers, publish ? 1 : 0);
  }
  state.rpc = () => ({ error: { message: "version_conflict" } });
  await content.handleProductContent(
    request({
      action: "save",
      blocks: [image],
      expected_version: 0,
      client_op_id: "save-queue-02",
      publish: true,
    }),
    device,
    sku,
  );
  assert.equal(state.triggers, 1);
});

for (const generated of [
  { blocks: [{ type: "paragraph", text: "1998年生产，绝版限量，功能正常。" }] },
  { blocks: [{ type: "paragraph", text: "<iframe src='x'></iframe>" }] },
  { blocks: [{ type: "image", storage_path: "sku-raw/another-store.jpg" }] },
  { blocks: [] },
])
  test(`unsafe or malformed AI output cannot change the draft: ${JSON.stringify(generated)}`, async () => {
    const previous = globalThis.fetch;
    const key = process.env.LOVABLE_API_KEY;
    process.env.LOVABLE_API_KEY = "test";
    globalThis.fetch = (async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify(generated) } }],
      })) as typeof fetch;
    try {
      const res = await content.handleProductContent(request({ action: "generate" }), device, sku);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, "generation_failed");
      assert.equal(state.calls.length, 1);
      assert.deepEqual(state.signed, []);
    } finally {
      globalThis.fetch = previous;
      if (key === undefined) delete process.env.LOVABLE_API_KEY;
      else process.env.LOVABLE_API_KEY = key;
    }
  });

test("generation preserves newly uploaded unsaved detail blocks, not just persisted images", async () => {
  const previous = globalThis.fetch;
  const key = process.env.LOVABLE_API_KEY;
  process.env.LOVABLE_API_KEY = "test";
  globalThis.fetch = (async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              blocks: [{ type: "paragraph", text: "A little warmth for the desk." }],
            }),
          },
        },
      ],
    })) as typeof fetch;
  try {
    const uploaded = {
      ...image,
      id: "unsaved",
      storage_path: `sku-raw/2026-09-27/${device.id}/new.jpg`,
    };
    const res = await content.handleProductContent(
      request({ action: "generate", blocks: [image, uploaded] }),
      device,
      sku,
    );
    const data = (await res.json()).data;
    assert.equal(res.status, 200);
    assert.deepEqual(
      data.blocks
        .filter((block: any) => block.type === "image")
        .map(({ read_url, ...block }: any) => block),
      [image, uploaded],
    );
    assert.equal(state.calls[0].args.p_request.blocks[1].id, "unsaved");
    assert.equal(data.draft_blocks.length, 1);
  } finally {
    globalThis.fetch = previous;
    if (key === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = key;
  }
});

test("invalid bodies and missing locations cannot reach RPC", async () => {
  for (const body of [
    { action: "save", blocks: [] },
    { action: "get", publish: true },
    { action: "generate", notes: "overwrite" },
  ]) {
    assert.equal((await content.handleProductContent(request(body), device, sku)).status, 422);
  }
  assert.equal(
    (
      await content.handleProductContent(
        request({ action: "get" }),
        { ...device, location_id: null },
        sku,
      )
    ).status,
    422,
  );
  assert.deepEqual(state.calls, []);
});

test("save returns a snapshot without reusing transient signed URLs as stored content", async () => {
  state.rpc = (_name: string, args: any) => ({
    data: {
      version: 1,
      draft_blocks: args.p_request.blocks,
      published_blocks: args.p_request.blocks,
    },
  });
  const res = await content.handleProductContent(
    request({
      action: "save",
      blocks: [image],
      expected_version: 0,
      client_op_id: "save-0010",
      publish: true,
    }),
    device,
    sku,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(state.calls[0].args.p_request.blocks, [image]);
  assert.deepEqual((await res.json()).data, {
    version: 1,
    draft_blocks: [{ ...image, read_url: null }],
    published_blocks: [{ ...image, read_url: null }],
  });
});
