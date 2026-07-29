import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { OfficialKnowledgeEditor } from "@/components/content/official-knowledge-editor";
import { getOfficialKnowledgeFn } from "@/lib/content-admin.functions";

export const Route = createFileRoute("/operations/official-knowledge/$id")({
  head: () => ({ meta: [{ title: "编辑官方知识 · BOOMER OFF" }] }),
  component: EditOfficialKnowledgePage,
});

function EditOfficialKnowledgePage() {
  const { id } = Route.useParams();
  const getFn = useServerFn(getOfficialKnowledgeFn);
  const knowledge = useQuery({
    queryKey: ["official-knowledge", id],
    queryFn: () => getFn({ data: { id } }),
  });
  if (knowledge.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!knowledge.data) {
    return <PageHeader title="知识词条不存在" description="该词条可能已被删除或无权访问。" />;
  }
  return (
    <div className="space-y-4">
      <PageHeader title="编辑官方知识" description="维护消费者知识和 ERP 主数据关系" />
      <OfficialKnowledgeEditor initial={knowledge.data as Record<string, unknown>} />
    </div>
  );
}
