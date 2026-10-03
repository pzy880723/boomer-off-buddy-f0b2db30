import { ArrowLeft, ChevronRight, Loader2, PackageOpen, RotateCcw } from "lucide-react";
import type { StandardCatalogGroup } from "@/lib/pos/standard-catalog";
import type { PosScannableProduct } from "@/lib/pos/pos-policy";

type Group = StandardCatalogGroup & { image_url?: string | null };
type Product = PosScannableProduct & { image_url: string | null };
export type PosCatalogProps = {
  tab: "standard" | "custom";
  groups: Group[];
  products: Product[];
  activeCategoryCode: string | null;
  subcategory: { code: string; name: string } | null;
  loading: boolean;
  error: string;
  onTab: (tab: "standard" | "custom") => void;
  onGroup: (code: string | null) => void;
  onSubcategory: (sub: { code: string; name: string } | null) => void;
  onPrice: (group: Group, price: { sku_id: string; price: number }) => void;
  onProduct: (product: Product) => void;
  onRetry: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
};

function Cover({ url }: { url?: string | null }) {
  return (
    <div className="aspect-[1.25] overflow-hidden bg-[#f2f4f7]">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <PackageOpen className="h-8 w-8 text-[#98a2b3]" />
        </div>
      )}
    </div>
  );
}

export function PosCatalog(props: PosCatalogProps) {
  const group = props.groups.find((g) => g.category_code === props.activeCategoryCode);
  const products = props.products.filter((p) => p.product_type === "custom");
  return (
    <section
      data-pos-catalog
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-[#e4e7ec] bg-white"
    >
      <div
        className="flex h-16 shrink-0 items-stretch gap-7 border-b border-[#eaecf0] px-4 sm:px-5"
        role="tablist"
        aria-label="商品类型"
      >
        {(["standard", "custom"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={props.tab === tab}
            aria-controls="pos-catalog-panel"
            id={`pos-tab-${tab}`}
            onClick={() => props.onTab(tab)}
            className={`border-b-[3px] px-0.5 text-base font-semibold ${props.tab === tab ? "border-[#0a315d] text-[#0a315d]" : "border-transparent text-[#667085]"}`}
          >
            {tab === "standard" ? "标准商品" : "自定义商品"}
          </button>
        ))}
        <span className="ml-auto hidden items-center text-xs text-[#667085] sm:flex">
          {props.tab === "standard"
            ? `${props.groups.length} 个商品组`
            : `${products.length} 件可售商品`}
        </span>
      </div>
      <div
        id="pos-catalog-panel"
        role="tabpanel"
        aria-labelledby={`pos-tab-${props.tab}`}
        className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5"
      >
        {props.loading ? (
          <div
            role="status"
            className="flex min-h-40 items-center justify-center gap-2 text-sm text-[#667085]"
          >
            <Loader2 className="h-5 w-5 animate-spin" />
            正在加载当前门店商品
          </div>
        ) : props.error ? (
          <div
            role="alert"
            className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm"
          >
            <p>{props.error}</p>
            <button
              type="button"
              onClick={props.onRetry}
              className="rounded-lg border px-5 py-2 text-[#0a315d]"
            >
              重试
            </button>
          </div>
        ) : props.tab === "standard" ? (
          group ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => props.onGroup(null)}
                  className="flex min-h-10 items-center gap-1 text-sm text-[#667085]"
                >
                  <ArrowLeft className="h-4 w-4" />
                  全部标准商品
                </button>
                <h2 className="font-semibold">{group.category_name}</h2>
                <span className="ml-auto text-xs text-[#667085]">点选价位，即可加购</span>
              </div>
              {group.subcategories.length > 0 && (
                <div className="mb-4 rounded-xl bg-[#f8fafc] p-3" role="group" aria-label="品类标签（可选）">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-xs">
                    <span className="font-medium text-[#344054]">品类标签（可选）</span>
                    <span className="text-[#667085]">先选标签再点价位；不选也可加购</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      aria-pressed={props.subcategory === null}
                      onClick={() => props.onSubcategory(null)}
                      className={`min-h-10 rounded-full border px-3 text-xs ${props.subcategory === null ? "border-[#0a315d] bg-[#0a315d] text-white" : "border-[#e4e7ec] bg-white text-[#475467]"}`}
                    >不选标签</button>
                    {group.subcategories.map((sub) => (
                      <button
                        key={sub.code}
                        type="button"
                        aria-pressed={props.subcategory?.code === sub.code}
                        onClick={() => props.onSubcategory(props.subcategory?.code === sub.code ? null : sub)}
                        className={`min-h-10 rounded-full border px-3 text-xs ${props.subcategory?.code === sub.code ? "border-[#0a315d] bg-[#0a315d] text-white" : "border-[#e4e7ec] bg-white text-[#475467]"}`}
                      >{sub.name}</button>
                    ))}
                  </div>
                </div>
              )}
              {group.prices.length === 0 ? (
                <p className="py-8 text-center text-sm text-[#667085]">该商品暂无可售价格档</p>
              ) : (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-5 xl:grid-cols-6">
                  {[...group.prices]
                    .sort((a, b) => a.price - b.price)
                    .map((price) => (
                      <button
                        key={price.sku_id}
                        type="button"
                        data-sku-id={price.sku_id}
                        onClick={() => props.onPrice(group, price)}
                        className="min-h-16 rounded-xl border border-[#e4e7ec] bg-white text-lg font-bold tabular-nums text-[#0a315d] transition hover:border-[#e8343a] hover:bg-[#fff1f2] hover:text-[#e8343a] active:bg-[#ffe3e6]"
                      >
                        ¥{price.price}
                      </button>
                    ))}
                </div>
              )}
            </>
          ) : props.groups.length === 0 ? (
            <p className="py-16 text-center text-sm text-[#667085]">当前门店暂无标准商品</p>
          ) : (
            <>
              <p className="mb-4 text-xs text-[#667085]">选商品名称，再选价位档</p>
              <div className="grid grid-cols-3 gap-3 lg:grid-cols-4 xl:grid-cols-5">
                {props.groups.map((g) => (
                  <button
                    key={g.category_code}
                    type="button"
                    onClick={() => props.onGroup(g.category_code)}
                    className="overflow-hidden rounded-xl border border-[#e4e7ec] text-left transition hover:border-[#0a315d] focus-visible:outline-[#0a315d]"
                  >
                    <Cover url={g.image_url} />
                    <div className="flex min-h-11 items-center justify-between gap-1 px-2.5 py-2">
                      <span className="text-xs font-semibold sm:text-sm">{g.category_name}</span>
                      <ChevronRight className="h-3 w-3 shrink-0 text-[#98a2b3]" />
                    </div>
                  </button>
                ))}
              </div>
            </>
          )
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between text-xs text-[#667085]">
              <span>仅显示当前门店可售商品</span>
              <button
                type="button"
                onClick={props.onRetry}
                className="flex min-h-9 items-center gap-1"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                刷新
              </button>
            </div>
            {products.length === 0 ? (
              <p className="py-16 text-center text-sm text-[#667085]">暂无可售自定义商品</p>
            ) : (
              <div className="grid grid-cols-3 gap-3 lg:grid-cols-4 xl:grid-cols-5">
                {products.map((p) => (
                  <button
                    key={p.sku_id}
                    type="button"
                    onClick={() => props.onProduct(p)}
                    className="overflow-hidden rounded-xl border border-[#e4e7ec] text-left transition hover:border-[#e8343a]"
                  >
                    <Cover url={p.image_url} />
                    <div className="p-2.5">
                      <p className="line-clamp-2 min-h-9 text-xs font-semibold">{p.name}</p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-1">
                        <b className="text-sm tabular-nums text-[#e8343a]">
                          ¥{p.unit_price.toFixed(2)}
                        </b>
                        <span className="text-[10px] text-[#667085]">库存 {p.available_qty}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {props.hasMore && (
              <button
                type="button"
                disabled={props.loadingMore}
                onClick={props.onMore}
                className="mt-4 min-h-11 w-full rounded-xl border text-sm text-[#0a315d]"
              >
                {props.loadingMore ? "正在加载更多" : "加载更多商品"}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
