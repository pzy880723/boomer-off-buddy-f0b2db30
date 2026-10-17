import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listListingReadiness, retryListingReadiness } from "@/lib/listing-readiness.functions";

export const Route = createFileRoute("/inventory/readiness")({
  head: () => ({
    meta: [
      { title: "上架准备进度 · BOOMER OFF ERP" },
      { name: "description", content: "新商品图片、识别、图文详情的准备进度与失败重试" },
      { property: "og:title", content: "上架准备进度 · BOOMER OFF ERP" },
      { property: "og:description", content: "新商品图片、识别、图文详情的准备进度与失败重试" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReadinessPage,
});

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "等待中", variant: "outline" },
  running: { label: "处理中", variant: "secondary" },
  succeeded: { label: "已完成", variant: "default" },
  failed: { label: "失败", variant: "destructive" },
};
const ERRORS: Record<string, string> = {
  missing_category: "缺少品名或分类",
  missing_images: "缺少商品图片",
  empty_content: "无法生成图文详情",
  image_failed: "图片处理失败",
  detail_image_failed: "详情图片处理失败",
  empty_content: "详情内容为空",
};
const MODES: Record<string, string> = { template: "自动模板", reused_existing: "沿用已有详情" };

function Step({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: "未知", variant: "outline" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function ReadinessPage() {
  const qc = useQueryClient();
  const list = useServerFn(listListingReadiness);
  const retry = useServerFn(retryListingReadiness);
  const { data = [], isLoading, error } = useQuery({ queryKey: ["listing-readiness"], queryFn: () => list() });
  const mutation = useMutation({
    mutationFn: (sku_id: string) => retry({ data: { sku_id } }),
    onSuccess: () => {
      toast.success("已重新排队处理");
      void qc.invalidateQueries({ queryKey: ["listing-readiness"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">上架准备进度</h1>
        <p className="text-sm text-muted-foreground">
          新商品需图片、识别、图文详情全部完成后才会对顾客展示；尺寸为选填，不影响上架。
        </p>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2">商品</th><th className="p-2">识别</th><th className="p-2">图片</th>
              <th className="p-2">图文详情</th><th className="p-2">待上架</th><th className="p-2">原因</th><th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const failed = [row.recognition_status, row.image_status, row.content_status].includes("failed");
              return (
                <tr key={row.sku_id} className="border-t">
                  <td className="p-2"><div className="font-medium">{row.name}</div><div className="text-xs text-muted-foreground">{row.sku_code}</div></td>
                  <td className="p-2"><Step status={row.recognition_status} /></td>
                  <td className="p-2"><Step status={row.image_status} /></td>
                  <td className="p-2"><Step status={row.content_status} />{row.content_mode && <div className="text-xs text-muted-foreground">{MODES[row.content_mode] ?? ""}</div>}</td>
                  <td className="p-2">{row.held_listings > 0 ? `${row.held_listings} 个门店等待发布` : "—"}</td>
                  <td className="p-2 text-xs">{row.last_error ? (ERRORS[row.last_error] ?? "处理失败") : ""}</td>
                  <td className="p-2">
                    <Button size="sm" variant={failed ? "default" : "outline"} disabled={mutation.isPending} onClick={() => mutation.mutate(row.sku_id)}>
                      {failed ? "失败重试" : "重新检查"}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {!isLoading && data.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">暂无新商品准备记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
