import { describe, it, expect } from "vitest";
import { buildSkuCovers, type CoverSigner, type SkuCoverSource } from "./sku-cover-batch";

function recordingSigner(
  resolve: (path: string) => string | null,
): { signer: CoverSigner; calls: string[][] } {
  const calls: string[][] = [];
  const signer: CoverSigner = async (paths) => {
    calls.push([...paths]);
    return paths.map((p) => resolve(p));
  };
  return { signer, calls };
}

describe("buildSkuCovers", () => {
  it("448 个 SKU 共用 14 张私桶图时，只发一次批量签名且只传 14 个去重路径", async () => {
    const rows: SkuCoverSource[] = Array.from({ length: 448 }, (_, i) => ({
      id: `sku-${i}`,
      image_paths: [`sku-listing/shared-${i % 14}.jpg`],
      image_url: null,
    }));
    const { signer, calls } = recordingSigner((p) => `https://signed.test/${p}?token=x`);

    const covers = await buildSkuCovers(rows, signer);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(14);
    expect(new Set(calls[0]).size).toBe(14);
    expect(Object.keys(covers)).toHaveLength(448);
    expect(covers["sku-0"]).toBe("https://signed.test/sku-listing/shared-0.jpg?token=x");
    expect(covers["sku-14"]).toBe(covers["sku-0"]);
  });

  it("跨多个私桶时仍只调用一次 signer，由 signer 内部按桶分组", async () => {
    const rows: SkuCoverSource[] = [
      { id: "a", image_paths: ["sku-listing/a.jpg"] },
      { id: "b", image_paths: ["sku-raw/b.jpg"] },
      { id: "c", image_paths: ["parcel-item-images/c.jpg"] },
    ];
    const { signer, calls } = recordingSigner((p) => `https://signed.test/${p}`);

    const covers = await buildSkuCovers(rows, signer);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "sku-listing/a.jpg",
      "sku-raw/b.jpg",
      "parcel-item-images/c.jpg",
    ]);
    expect(covers["c"]).toBe("https://signed.test/parcel-item-images/c.jpg");
  });

  it("完全无图的 SKU 返回 null，且不进入签名批次", async () => {
    const rows: SkuCoverSource[] = [
      { id: "empty", image_paths: [], image_url: null },
      { id: "nullish", image_paths: null, image_url: null },
    ];
    const { signer, calls } = recordingSigner(() => null);

    const covers = await buildSkuCovers(rows, signer);

    expect(calls).toHaveLength(0);
    expect(covers).toEqual({ empty: null, nullish: null });
  });

  it("首图为 https / data: 时原样透传，不进签名批次", async () => {
    const rows: SkuCoverSource[] = [
      { id: "http", image_paths: ["https://cdn.test/x.jpg"] },
      { id: "data", image_paths: ["data:image/png;base64,AAA"] },
    ];
    const { signer, calls } = recordingSigner(() => null);

    const covers = await buildSkuCovers(rows, signer);

    expect(calls).toHaveLength(0);
    expect(covers["http"]).toBe("https://cdn.test/x.jpg");
    expect(covers["data"]).toBe("data:image/png;base64,AAA");
  });

  it("无首图时回退合法 image_url；已签名的 token= 外链不作为回退", async () => {
    const rows: SkuCoverSource[] = [
      { id: "fallback", image_paths: [], image_url: "https://cdn.test/fallback.jpg" },
      { id: "signed-url", image_paths: [], image_url: "https://cdn.test/x.jpg?token=abc" },
    ];
    const { signer } = recordingSigner(() => null);

    const covers = await buildSkuCovers(rows, signer);

    expect(covers["fallback"]).toBe("https://cdn.test/fallback.jpg");
    expect(covers["signed-url"]).toBeNull();
  });

  it("签名 502 失败但有合法 image_url 时回退，不抛错", async () => {
    const rows: SkuCoverSource[] = [
      { id: "a", image_paths: ["sku-listing/a.jpg"], image_url: "https://cdn.test/a.jpg" },
    ];
    const { signer } = recordingSigner(() => null);

    const covers = await buildSkuCovers(rows, signer);

    expect(covers["a"]).toBe("https://cdn.test/a.jpg");
  });

  it("签名 502 失败且无回退图时必须抛错，不能伪装成本来无图", async () => {
    const rows: SkuCoverSource[] = [
      { id: "ok", image_paths: ["sku-listing/ok.jpg"] },
      { id: "boom", image_paths: ["sku-listing/boom.jpg"], image_url: null },
    ];
    const signer: CoverSigner = async (paths) =>
      paths.map((p) => (p.includes("boom") ? null : `https://signed.test/${p}`));

    await expect(buildSkuCovers(rows, signer)).rejects.toThrow(/封面签名失败/);
  });

  it("signer 自身抛错时向上传播", async () => {
    const rows: SkuCoverSource[] = [{ id: "a", image_paths: ["sku-listing/a.jpg"] }];
    const signer: CoverSigner = async () => {
      throw new Error("storage 502");
    };

    await expect(buildSkuCovers(rows, signer)).rejects.toThrow("storage 502");
  });

  it("未知桶前缀按无图处理并回退 image_url，不触发签名失败抛错", async () => {
    const rows: SkuCoverSource[] = [
      { id: "unknown", image_paths: ["mystery-bucket/x.jpg"], image_url: "https://cdn.test/u.jpg" },
      { id: "unknown-nofallback", image_paths: ["mystery-bucket/y.jpg"], image_url: null },
    ];
    const { signer, calls } = recordingSigner(() => null);

    const covers = await buildSkuCovers(rows, signer);

    expect(calls).toHaveLength(0);
    expect(covers["unknown"]).toBe("https://cdn.test/u.jpg");
    expect(covers["unknown-nofallback"]).toBeNull();
  });
});
