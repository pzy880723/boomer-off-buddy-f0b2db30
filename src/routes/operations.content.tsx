import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { FileText, Plus, Search, Video, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { listEditorialContentFn } from "@/lib/content-admin.functions";

export const Route = createFileRoute("/operations/content")({
  head: () => ({ meta: [{ title: "资讯管理 · BOOMER OFF" }] }),
  component: ContentOperationsPage,
});

const typeLabels: Record<string, string> = {
  article: "图文",
  horizontal_video: "横版视频",
  vertical_video: "竖版视频",
};
const statusLabels: Record<string, string> = {
  draft: "草稿",
  pending_review: "待审核",
  scheduled: "定时发布",
  published: "已发布",
  archived: "已归档",
};

function ContentOperationsPage() {
  const listFn = useServerFn(listEditorialContentFn);
  const [query, setQuery] = useState("");
  const contents = useQuery({
    queryKey: ["editorial-contents"],
    queryFn: () => listFn(),
  });
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = (contents.data ?? []) as Record<string, unknown>[];
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.title, row.summary, row.slug].join(" ").toLowerCase().includes(needle),
    );
  }, [contents.data, query]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="资讯管理"
        description="统一编辑 App 图文、横版视频与竖版视频，管理审核、定时发布和内容关联"
        actions={
          <Button asChild>
            <Link to="/operations/content/new">
              <Plus className="mr-2 h-4 w-4" />
              新建内容
            </Link>
          </Button>
        }
      />
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="搜索标题、摘要或 Slug"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {contents.isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : contents.isError ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-destructive">
            资讯读取失败，请确认数据库迁移已部署。
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            暂无内容，先创建第一篇资讯。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {items.map((row) => {
            const id = String(row.id);
            const type = String(row.type);
            return (
              <Link key={id} to="/operations/content/$id" params={{ id }}>
                <Card className="transition hover:-translate-y-0.5 hover:shadow-md">
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                      {type === "article" ? (
                        <FileText className="h-5 w-5" />
                      ) : (
                        <Video className="h-5 w-5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold">{String(row.title)}</p>
                        <Badge variant="outline">{typeLabels[type] ?? type}</Badge>
                        <Badge variant={row.status === "published" ? "default" : "secondary"}>
                          {statusLabels[String(row.status)] ?? String(row.status)}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                        {String(row.summary)}
                      </p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p>
                        {Array.isArray(row.channel_ids) ? row.channel_ids.join(" · ") : "未分频道"}
                      </p>
                      <p className="mt-1">{String(row.updated_at ?? "").slice(0, 10)}</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
