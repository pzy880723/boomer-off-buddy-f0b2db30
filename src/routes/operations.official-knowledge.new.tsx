import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { OfficialKnowledgeEditor } from "@/components/content/official-knowledge-editor";

export const Route = createFileRoute("/operations/official-knowledge/new")({
  head: () => ({ meta: [{ title: "新建官方知识 · BOOMER OFF" }] }),
  component: NewOfficialKnowledgePage,
});

function NewOfficialKnowledgePage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="新建官方知识"
        description="创建面向消费者、可与商品和识别结果关联的知识词条"
      />
      <OfficialKnowledgeEditor />
    </div>
  );
}
