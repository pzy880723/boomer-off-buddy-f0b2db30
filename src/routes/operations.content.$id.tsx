import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ContentEditor } from "@/components/content/content-editor";
import { getEditorialContentFn } from "@/lib/content-admin.functions";

export const Route = createFileRoute("/operations/content/$id")({
  head: () => ({ meta: [{ title: "编辑资讯 · BOOMER OFF" }] }),
  component: EditContentPage,
});

function EditContentPage() {
  const { id } = Route.useParams();
  const getFn = useServerFn(getEditorialContentFn);
  const content = useQuery({
    queryKey: ["editorial-content", id],
    queryFn: () => getFn({ data: { id } }),
  });
  if (content.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!content.data) {
    return <PageHeader title="内容不存在" description="该内容可能已被删除或无权访问。" />;
  }
  return (
    <div className="space-y-4">
      <PageHeader title="编辑资讯" description="修改内容、分发和发布设置" />
      <ContentEditor initial={content.data as Record<string, unknown>} />
    </div>
  );
}
