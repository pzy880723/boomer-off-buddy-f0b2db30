import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Eye, Save, Send, Video, FileText } from "lucide-react";
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
import {
  changeEditorialContentStatusFn,
  saveEditorialContentFn,
} from "@/lib/content-admin.functions";

type EditorRecord = Record<string, unknown>;

const defaultSource = {
  id: "boomer-editorial",
  name: "BOOMER 编辑部",
  kind: "boomer_original",
  label: "BOOMER 原创",
  original_url: null,
  ai_summarized: false,
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function list(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

export function ContentEditor({ initial }: { initial?: EditorRecord | null }) {
  const navigate = useNavigate();
  const saveFn = useServerFn(saveEditorialContentFn);
  const statusFn = useServerFn(changeEditorialContentStatusFn);
  const [type, setType] = useState(text(initial?.type, "article"));
  const [title, setTitle] = useState(text(initial?.title));
  const [slug, setSlug] = useState(text(initial?.slug));
  const [summary, setSummary] = useState(text(initial?.summary));
  const [body, setBody] = useState(text(initial?.body));
  const [coverUrl, setCoverUrl] = useState(text(initial?.cover_url));
  const [videoUrl, setVideoUrl] = useState(text(initial?.video_url));
  const [channels, setChannels] = useState(list(initial?.channel_ids).join(", "));
  const [keywords, setKeywords] = useState(list(initial?.keywords).join(", "));
  const [sourceName, setSourceName] = useState(
    text((initial?.source as EditorRecord | undefined)?.name, "BOOMER 编辑部"),
  );
  const [scheduledAt, setScheduledAt] = useState(text(initial?.scheduled_at).slice(0, 16));
  const isVideo = type !== "article";

  const payload = useMemo(
    () => ({
      ...(typeof initial?.id === "string" ? { id: initial.id } : {}),
      slug: slug.trim(),
      type: type as "article" | "horizontal_video" | "vertical_video",
      status: text(initial?.status, "draft") as
        "draft" | "pending_review" | "scheduled" | "published" | "archived",
      title: title.trim(),
      summary: summary.trim(),
      body: type === "article" ? body.trim() || null : null,
      cover_url: coverUrl.trim() || null,
      video_url: isVideo ? videoUrl.trim() || null : null,
      aspect_ratio: type === "vertical_video" ? 9 / 16 : 16 / 9,
      duration_seconds: isVideo ? Number(initial?.duration_seconds ?? 0) : 0,
      source: { ...defaultSource, name: sourceName.trim() },
      channel_ids: channels
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      keywords: keywords
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      related_product_ids: list(initial?.related_product_ids),
      related_knowledge_ids: list(initial?.related_knowledge_ids),
      scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      published_at: text(initial?.published_at) || null,
    }),
    [
      body,
      channels,
      coverUrl,
      initial,
      isVideo,
      keywords,
      scheduledAt,
      slug,
      sourceName,
      summary,
      title,
      type,
      videoUrl,
    ],
  );

  const save = useMutation({
    mutationFn: () => saveFn({ data: payload }),
    onSuccess: (saved) => {
      toast.success("内容已保存");
      void navigate({
        to: "/operations/content/$id",
        params: { id: String(saved.id) },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "保存失败"),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const saved = await saveFn({ data: payload });
      return statusFn({
        data: { id: String(saved.id), status: "pending_review" },
      });
    },
    onSuccess: () => {
      toast.success("已提交审核");
      void navigate({ to: "/operations/content" });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "提交失败"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => void navigate({ to: "/operations/content" })}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回资讯管理
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => toast.info("预览将在 App 样式中打开")}>
            <Eye className="mr-2 h-4 w-4" />
            预览
          </Button>
          <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
            <Save className="mr-2 h-4 w-4" />
            保存草稿
          </Button>
          <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
            <Send className="mr-2 h-4 w-4" />
            提交审核
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {isVideo ? <Video className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
              内容正文
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>标题</Label>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>摘要</Label>
              <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
            </div>
            {type === "article" ? (
              <div className="space-y-2">
                <Label>正文</Label>
                <Textarea
                  className="min-h-80"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>视频 URL</Label>
                <Input value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} />
                <p className="text-xs text-muted-foreground">
                  横版建议 16:9，竖版建议 9:16；发布前请确认 CDN 可公开访问。
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>发布设置</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>内容类型</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="article">图文资讯</SelectItem>
                    <SelectItem value="horizontal_video">横版视频</SelectItem>
                    <SelectItem value="vertical_video">竖版视频</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Slug</Label>
                <Input value={slug} onChange={(event) => setSlug(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>封面 URL</Label>
                <Input value={coverUrl} onChange={(event) => setCoverUrl(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>定时发布</Label>
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>分发与关联</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>频道编码（逗号分隔）</Label>
                <Input value={channels} onChange={(event) => setChannels(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>关键词（逗号分隔）</Label>
                <Input value={keywords} onChange={(event) => setKeywords(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>内容来源</Label>
                <Input value={sourceName} onChange={(event) => setSourceName(event.target.value)} />
              </div>
              <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                商品、品牌、分类、IP 与标签关系只保存 ERP 主数据
                ID/编码；品牌未确认时保持“品牌待确认”，不会自动创建品牌。
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
