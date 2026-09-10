import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSkuCovers, type CoverSigner, type SkuCoverSource } from "./sku-cover-batch";

function recordingSigner(resolve: (path: string) => string | null): {
  signer: CoverSigner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const signer: CoverSigner = async (paths) => {
    calls.push([...paths]);
    return paths.map((p) => resolve(p));
  };
  return { signer, calls };
}

test("448 个 SKU 共用 14 张私桶图时，只发一次批量签名且只传 14 个去重路径", async () => {
  const rows: SkuCoverSource[] = Array.from({ length: 448 }, (_, i) => ({
    id: `sku-${i}`,
    image_paths: [`sku-listing/shared-${i % 14}.jpg`],
    image_url: null,
  }));
  const { signer, calls } = recordingSigner((p) => `https://signed.test/${p}?token=x`);

  const covers = await buildSkuCovers(rows, signer);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 14);
  assert.equal(new Set(calls[0]).size, 14);
  assert.equal(Object.keys(covers).length, 448);
  assert.equal(covers["sku-0"], "https://signed.test/sku-listing/shared-0.jpg?token=x");
  assert.equal(covers["sku-14"], covers["sku-0"]);
});

test("跨多个私桶时仍只调用一次 signer，由 signer 内部按桶分组", async () => {
  const rows: SkuCoverSource[] = [
    { id: "a", image_paths: ["sku-listing/a.jpg"] },
    { id: "b", image_paths: ["sku-raw/b.jpg"] },
    { id: "c", image_paths: ["parcel-item-images/c.jpg"] },
  ];
  const { signer, calls } = recordingSigner((p) => `https://signed.test/${p}`);

  const covers = await buildSkuCovers(rows, signer);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "sku-listing/a.jpg",
    "sku-raw/b.jpg",
    "parcel-item-images/c.jpg",
  ]);
  assert.equal(covers["c"], "https://signed.test/parcel-item-images/c.jpg");
});

test("完全无图的 SKU 返回 null，且不进入签名批次", async () => {
  const rows: SkuCoverSource[] = [
    { id: "empty", image_paths: [], image_url: null },
    { id: "nullish", image_paths: null, image_url: null },
  ];
  const { signer, calls } = recordingSigner(() => null);

  const covers = await buildSkuCovers(rows, signer);

  assert.equal(calls.length, 0);
  assert.deepEqual(covers, { empty: null, nullish: null });
});

test("首图为 https / data: 时原样透传，不进签名批次", async () => {
  const rows: SkuCoverSource[] = [
    { id: "http", image_paths: ["https://cdn.test/x.jpg"] },
    { id: "data", image_paths: ["data:image/png;base64,AAA"] },
  ];
  const { signer, calls } = recordingSigner(() => null);

  const covers = await buildSkuCovers(rows, signer);

  assert.equal(calls.length, 0);
  assert.equal(covers["http"], "https://cdn.test/x.jpg");
  assert.equal(covers["data"], "data:image/png;base64,AAA");
});

test("无首图时回退合法 image_url；已签名的 token= 外链不作为回退", async () => {
  const rows: SkuCoverSource[] = [
    { id: "fallback", image_paths: [], image_url: "https://cdn.test/fallback.jpg" },
    { id: "signed-url", image_paths: [], image_url: "https://cdn.test/x.jpg?token=abc" },
  ];
  const { signer } = recordingSigner(() => null);

  const covers = await buildSkuCovers(rows, signer);

  assert.equal(covers["fallback"], "https://cdn.test/fallback.jpg");
  assert.equal(covers["signed-url"], null);
});

test("签名 502 失败但有合法 image_url 时回退，不抛错", async () => {
  const rows: SkuCoverSource[] = [
    { id: "a", image_paths: ["sku-listing/a.jpg"], image_url: "https://cdn.test/a.jpg" },
  ];
  const { signer } = recordingSigner(() => null);

  const covers = await buildSkuCovers(rows, signer);

  assert.equal(covers["a"], "https://cdn.test/a.jpg");
});

test("签名 502 失败且无回退图时必须抛错，不能伪装成本来无图", async () => {
  const rows: SkuCoverSource[] = [
    { id: "ok", image_paths: ["sku-listing/ok.jpg"] },
    { id: "boom", image_paths: ["sku-listing/boom.jpg"], image_url: null },
  ];
  const signer: CoverSigner = async (paths) =>
    paths.map((p) => (p.includes("boom") ? null : `https://signed.test/${p}`));

  await assert.rejects(() => buildSkuCovers(rows, signer), /封面签名失败/);
});

test("signer 自身抛错时向上传播", async () => {
  const rows: SkuCoverSource[] = [{ id: "a", image_paths: ["sku-listing/a.jpg"] }];
  const signer: CoverSigner = async () => {
    throw new Error("storage 502");
  };

  await assert.rejects(() => buildSkuCovers(rows, signer), /storage 502/);
});

test("未知桶前缀按无图处理并回退 image_url，不触发签名失败抛错", async () => {
  const rows: SkuCoverSource[] = [
    { id: "unknown", image_paths: ["mystery-bucket/x.jpg"], image_url: "https://cdn.test/u.jpg" },
    { id: "unknown-nofallback", image_paths: ["mystery-bucket/y.jpg"], image_url: null },
  ];
  const { signer, calls } = recordingSigner(() => null);

  const covers = await buildSkuCovers(rows, signer);

  assert.equal(calls.length, 0);
  assert.equal(covers["unknown"], "https://cdn.test/u.jpg");
  assert.equal(covers["unknown-nofallback"], null);
});
