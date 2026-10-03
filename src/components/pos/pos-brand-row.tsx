import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { rankPosBrands, type PosBrand } from "@/lib/pos/brand-catalog";

export function PosBrandRow({ brands, category, value, onChange }: {
  brands: PosBrand[];
  category: string;
  value: PosBrand | null;
  onChange: (brand: PosBrand | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const recommended = rankPosBrands(brands, category).slice(0, 8);
  const choices = value && !recommended.some((brand) => brand.id === value.id)
    ? [value, ...recommended] : recommended;
  const style = (active: boolean) => `min-h-8 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs ${active ? "border-[#0a315d] bg-[#0a315d] text-white" : "border-[#e4e7ec] bg-white text-[#475467]"}`;
  return (
    <div role="group" aria-label="品牌标签（可选）" className="flex min-w-0 items-center gap-2 border-b border-[#eaecf0]">
      <span className="w-16 shrink-0 whitespace-nowrap text-xs text-[#667085]">品牌／窑口</span>
      <div className="flex min-w-0 flex-1 flex-nowrap gap-1.5 overflow-x-auto py-1.5">
        <button type="button" aria-pressed={!value} className={style(!value)} onClick={() => onChange(null)}>不选品牌</button>
        {choices.map((brand) => <button key={brand.id} type="button" aria-pressed={value?.id === brand.id}
          className={style(value?.id === brand.id)} onClick={() => onChange(value?.id === brand.id ? null : brand)}>{brand.name}</button>)}
      </div>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
        <PopoverTrigger asChild><button type="button" className="min-h-9 shrink-0 px-1 text-xs font-semibold text-[#0a315d]">更多品牌</button></PopoverTrigger>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-32px)] p-3">
          <input aria-label="搜索品牌" placeholder="搜索中文、英文或品牌别名" value={query} onChange={(event) => setQuery(event.target.value)}
            className="mb-2 h-10 w-full rounded-lg border px-3 text-sm" />
          <div className="max-h-64 overflow-y-auto" role="group" aria-label="全部品牌">
            {rankPosBrands(brands, category, query).map((brand) => <button key={brand.id} type="button"
              aria-pressed={value?.id === brand.id} className="block min-h-10 w-full rounded-lg px-2 text-left text-sm hover:bg-slate-100"
              onClick={() => { onChange(brand); setOpen(false); setQuery(""); }}>{brand.name}</button>)}
            {rankPosBrands(brands, category, query).length === 0 && <p className="p-2 text-xs text-[#667085]">未找到品牌，可暂不选择，稍后在 ERP 品牌库补充。</p>}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
