import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Loader2, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listOfficialKnowledgeFn } from "@/lib/content-admin.functions";

export const Route = createFileRoute("/operations/official-knowledge")({
  head: () => ({ meta: [{ title: "官方知识 · BOOMER OFF" }] }),
  component: OfficialKnowledgePage,
});

function OfficialKnowledgePage() {
  const listFn = useServerFn(listOfficialKnowledgeFn);
  const knowledge = useQuery({
    queryKey: ["official-knowledge"],
    queryFn: () => listFn(),
  });
  const items = (knowledge.data ?? []) as Record<string, unknown>[];
  return (
    <div className="space-y-4">
      <PageHeader
        title="官方知识"
        description="面向消费者的品牌、分类、IP、年代、工艺与收藏知识；统一关联 ERP 主数据"
        actions={
          <Button asChild>
            <Link to="/operations/official-knowledge/new">
              <Plus className="mr-2 h-4 w-4" />
              新建词条
            </Link>
          </Button>
        }
      />
      {knowledge.isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : knowledge.isError ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-destructive">
            官方知识读取失败，请确认数据库迁移已部署。
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            暂无官方知识，先建立第一条消费者知识词条。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((row) => (
            <Link
              key={String(row.id)}
              to="/operations/official-knowledge/$id"
              params={{ id: String(row.id) }}
            >
              <Card className="h-full transition hover:-translate-y-0.5 hover:shadow-md">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <BookOpen className="h-5 w-5" />
                    </div>
                    <Badge variant={row.status === "published" ? "default" : "secondary"}>
                      {String(row.status)}
                    </Badge>
                  </div>
                  <p className="mt-4 font-semibold">{String(row.title)}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {String(row.summary)}
                  </p>
                  <p className="mt-4 text-xs text-muted-foreground">{String(row.type)}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
