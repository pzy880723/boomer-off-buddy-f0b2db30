import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, Search, Eye, Calendar, TrendingUp, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { knowledgeArticles, knowledgeCategories } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/knowledge")({
  head: () => ({
    meta: [
      { title: "内部知识库 · BOOMER OFF" },
      { name: "description", content: "内部 SOP、QA、培训与门店流程" },
    ],
  }),
  component: KnowledgePage,
});

const typeMap: Record<string, string> = {
  全部文章: "all",
  商品知识: "product",
  SOP: "sop",
  QA: "qa",
  装修流程: "deco",
  品牌手册: "brand",
};

function KnowledgePage() {
  const [active, setActive] = useState<string>("all");
  const list =
    active === "all"
      ? knowledgeArticles
      : knowledgeArticles.filter((a) => typeMap[a.type] === active);
  const popular = [...knowledgeArticles].sort((a, b) => b.views - a.views).slice(0, 4);

  return (
    <div>
      <PageHeader
        title="内部知识库"
        description="仅供员工使用的标准 SOP、问答手册、门店流程与加盟商培训资料"
        meta={
          <span>
            共 {knowledgeArticles.length} 篇文章 · 累计阅读{" "}
            {knowledgeArticles.reduce((s, a) => s + a.views, 0).toLocaleString()} 次
          </span>
        }
        actions={
          <Button
            size="sm"
            className="bg-gradient-brand hover:opacity-90"
            onClick={() => toast.info("功能开发中")}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            新增文章
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[220px_1fr_240px]">
        {/* Categories */}
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="搜索文章…" className="h-9 pl-8" />
          </div>
          <Card className="p-2">
            <ul className="space-y-0.5">
              {knowledgeCategories.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setActive(c.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
                      active === c.id
                        ? "bg-gradient-brand text-primary-foreground shadow-elegant"
                        : "text-foreground hover:bg-accent",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <BookOpen className="h-3.5 w-3.5 opacity-70" />
                      {c.label}
                    </span>
                    <span className="tabular-nums text-xs opacity-70">{c.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        {/* Article list */}
        <div className="space-y-3">
          {list.map((a) => (
            <Card
              key={a.id}
              className="cursor-pointer overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover"
            >
              <div className="flex">
                <img
                  src={a.cover}
                  alt=""
                  className="h-28 w-32 shrink-0 object-cover sm:h-32 sm:w-40"
                />
                <CardContent className="flex-1 p-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {a.type}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground tabular-nums inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {a.updated}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums inline-flex items-center gap-1">
                      <Eye className="h-3 w-3" />
                      {a.views.toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1.5 text-base font-semibold leading-tight">{a.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>
                </CardContent>
              </div>
            </Card>
          ))}
        </div>

        {/* Popular */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <TrendingUp className="h-4 w-4 text-primary" />
                热门文章
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {popular.map((a, i) => (
                <div key={a.id} className="flex items-start gap-2">
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold",
                      i < 3
                        ? "bg-gradient-brand text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-xs font-medium leading-snug">{a.title}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                      {a.views.toLocaleString()} 次阅读
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
