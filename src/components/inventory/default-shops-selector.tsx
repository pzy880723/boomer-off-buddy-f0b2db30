import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Store, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { listYouzanShops } from "@/lib/youzan.functions";

/**
 * 仓库新建 SKU 时的「默认铺货门店」多选。
 * - value: uuid[]，空数组语义 = 铺给所有 branch
 * - 只列出 role=branch 且 status=active 的分店
 * - 存入 inv_skus.default_shop_ids；Round B 铺货 worker 上线后自动消费
 */
export function DefaultShopsSelector({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const fetchShops = useServerFn(listYouzanShops);
  const q = useQuery({
    queryKey: ["yz-branch-shops-selector"],
    queryFn: () => fetchShops(),
  });
  const branches = (q.data?.shops ?? []).filter(
    (s) => s.role === "branch" && s.status === "active",
  );

  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  };
  const selectAll = () => onChange([]);
  const isAll = value.length === 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5">
          <Store className="h-3.5 w-3.5" /> 默认铺货门店
        </Label>
        <button
          type="button"
          onClick={selectAll}
          className={`text-[11px] underline-offset-2 hover:underline ${
            isAll ? "text-primary font-medium" : "text-muted-foreground"
          }`}
        >
          铺给所有分店
        </button>
      </div>
      <div className="rounded-md border bg-muted/20 p-2">
        {q.isLoading ? (
          <p className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> 加载分店…
          </p>
        ) : branches.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            当前没有已激活的有赞分店
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-1">
            {branches.map((s) => {
              const checked = isAll || value.includes(s.id);
              return (
                <li key={s.id}>
                  <label
                    className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-background ${
                      isAll ? "opacity-70" : ""
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={isAll}
                      onCheckedChange={() => toggle(s.id)}
                    />
                    <span className="truncate">{s.shop_name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {isAll ? (
          <Badge variant="outline" className="mr-1 text-[10px]">
            铺给所有分店
          </Badge>
        ) : (
          <Badge variant="outline" className="mr-1 text-[10px]">
            仅铺给 {value.length} 家
          </Badge>
        )}
        创建后由后台自动同步到有赞总部并铺货到所选门店。
      </p>
    </div>
  );
}
