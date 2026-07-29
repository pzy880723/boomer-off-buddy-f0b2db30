import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { ContentEditor } from "@/components/content/content-editor";

export const Route = createFileRoute("/operations/content/new")({
  head: () => ({ meta: [{ title: "新建资讯 · BOOMER OFF" }] }),
  component: NewContentPage,
});

function NewContentPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="新建资讯" description="创建 App 图文、横版视频或竖版视频" />
      <ContentEditor />
    </div>
  );
}
