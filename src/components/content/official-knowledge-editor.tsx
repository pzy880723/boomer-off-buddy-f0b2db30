import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveOfficialKnowledgeFn } from "@/lib/content-admin.functions";

type EditorRecord = Record<string, unknown>;
const types = [
  ["brand", "品牌"],
  ["category", "分类"],
  ["ip", "IP"],
  ["character_series", "角色 / 系列"],
  ["era_style", "年代 / 风格"],
  ["material_craft", "材质 / 工艺"],
  ["origin_kiln", "产地 / 窑口"],
  ["collection_care", "收藏 / 保养"],
] as const;

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function OfficialKnowledgeEditor({ initial }: { initial?: EditorRecord | null }) {
  const navigate = useNavigate();
  const saveFn = useServerFn(saveOfficialKnowledgeFn);
  const [type, setType] = useState(text(initial?.type) || "brand");
  const [title, setTitle] = useState(text(initial?.title));
  const [slug, setSlug] = useState(text(initial?.slug));
  const [summary, setSummary] = useState(text(initial?.summary));
  const [story, setStory] = useState(text(initial?.story));
  const [evidence, setEvidence] = useState(
    Array.isArray(initial?.evidence) ? initial.evidence.join("\n") : "",
  );
  const [careAdvice, setCareAdvice] = useState(
    Array.isArray(initial?.care_advice) ? initial.care_advice.join("\n") : "",
  );
  const [coverUrl, setCoverUrl] = useState(text(initial?.cover_url));
  const [keywords, setKeywords] = useState(
    Array.isArray(initial?.keywords) ? initial.keywords.join(", ") : "",
  );
  const relations = Array.isArray(initial?.relations) ? (initial.relations as EditorRecord[]) : [];
  const [entityType, setEntityType] = useState(
    text(relations.find((relation) => relation.is_primary)?.entity_type) || "brand",
  );
  const [entityKey, setEntityKey] = useState(
    text(relations.find((relation) => relation.is_primary)?.entity_key),
  );
  const [entityLabel, setEntityLabel] = useState(
    text(relations.find((relation) => relation.is_primary)?.label),
  );

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          ...(typeof initial?.id === "string" ? { id: initial.id } : {}),
          slug: slug.trim(),
          type: type as (typeof types)[number][0],
          status:
            (text(initial?.status) as
              "draft" | "pending_review" | "scheduled" | "published" | "archived") || "draft",
          title: title.trim(),
          summary: summary.trim(),
          story: story.trim(),
          evidence: evidence
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          care_advice: careAdvice
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          cover_url: coverUrl.trim() || null,
          keywords: keywords
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          published_at: text(initial?.published_at) || null,
          relations: [
            {
              entity_type: entityType as "primary_category" | "brand" | "facet" | "product",
              entity_key: entityKey.trim(),
              label: entityLabel.trim(),
              is_primary: true,
            },
          ],
        },
      }),
    onSuccess: (saved) => {
      toast.success("官方知识已保存");
      void navigate({
        to: "/operations/official-knowledge/$id",
        params: { id: String(saved?.id) },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "保存失败"),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <Button
          variant="ghost"
          onClick={() => void navigate({ to: "/operations/official-knowledge" })}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回官方知识
        </Button>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          <Save className="mr-2 h-4 w-4" />
          保存词条
        </Button>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader>
            <CardTitle>消费者知识内容</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>标题</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>一句话摘要</Label>
              <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>故事正文</Label>
              <Textarea
                className="min-h-72"
                value={story}
                onChange={(e) => setStory(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>可验证依据（每行一条）</Label>
              <Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>收藏 / 保养建议（每行一条）</Label>
              <Textarea value={careAdvice} onChange={(e) => setCareAdvice(e.target.value)} />
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>知识类型</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {types.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-2">
                <Label>Slug</Label>
                <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>封面 URL</Label>
                <Input value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>关键词</Label>
                <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>ERP 主数据关系</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select value={entityType} onValueChange={setEntityType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="brand">品牌 ID</SelectItem>
                  <SelectItem value="primary_category">分类编码</SelectItem>
                  <SelectItem value="facet">IP / 标签编码</SelectItem>
                  <SelectItem value="product">商品 UUID</SelectItem>
                </SelectContent>
              </Select>
              <div className="space-y-2">
                <Label>主数据 ID / 编码</Label>
                <Input value={entityKey} onChange={(e) => setEntityKey(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>显示名称</Label>
                <Input
                  placeholder="品牌待确认时不要新建品牌"
                  value={entityLabel}
                  onChange={(e) => setEntityLabel(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                此处只关联既有 ERP 主数据，不负责创建品牌、分类或 IP。
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
