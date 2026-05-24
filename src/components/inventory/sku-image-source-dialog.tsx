import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sparkles, Search, Check } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  generateSkuImage,
  searchSkuImages,
  saveImageFromUrl,
} from "@/lib/sku-image.functions";

export function SkuImageSourceDialog({
  open,
  onOpenChange,
  defaultName,
  defaultCategoryLabel,
  initialTab = "ai",
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultName?: string;
  defaultCategoryLabel?: string;
  initialTab?: "ai" | "search";
  onPick: (url: string) => void;
}) {
  const gen = useServerFn(generateSkuImage);
  const search = useServerFn(searchSkuImages);
  const save = useServerFn(saveImageFromUrl);

  const defaultPrompt = [defaultCategoryLabel, defaultName, "商品白底图 高清 正面"]
    .filter(Boolean)
    .join(" ");

  const [tab, setTab] = useState<"ai" | "search">(initialTab);
  const [prompt, setPrompt] = useState(defaultPrompt || "");
  const [aiResult, setAiResult] = useState<string | null>(null);

  const [query, setQuery] = useState(defaultName || "");
  const [results, setResults] = useState<{ url: string; title: string }[]>([]);

  const genMut = useMutation({
    mutationFn: () => gen({ data: { prompt: prompt.trim() } }),
    onSuccess: (r) => setAiResult(r.dataUrl),
    onError: (e) => toast.error((e as Error).message),
  });

  const searchMut = useMutation({
    mutationFn: () => search({ data: { query: query.trim() } }),
    onSuccess: (r) => {
      setResults(r.images);
      if (r.images.length === 0) toast.message("没有搜到图片，换个关键词试试");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const saveMut = useMutation({
    mutationFn: (url: string) => save({ data: { url } }),
    onSuccess: (r) => {
      onPick(r.imageUrl);
      toast.success("已选用此图");
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>添加商品图片</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "ai" | "search")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="ai">
              <Sparkles className="mr-1.5 h-4 w-4" />AI 生成
            </TabsTrigger>
            <TabsTrigger value="search">
              <Search className="mr-1.5 h-4 w-4" />在线搜索
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ai" className="space-y-3 pt-4">
            <div className="space-y-1.5">
              <Label>生成提示词</Label>
              <Textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如：奥特曼软胶玩偶 商品白底图 正面 高清"
              />
            </div>
            <Button
              onClick={() => { setAiResult(null); genMut.mutate(); }}
              disabled={genMut.isPending || prompt.trim().length < 2}
            >
              {genMut.isPending ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />生成中…</>
              ) : (
                <><Sparkles className="mr-1.5 h-4 w-4" />{aiResult ? "重新生成" : "生成图片"}</>
              )}
            </Button>

            {aiResult && (
              <div className="space-y-2">
                <div className="overflow-hidden rounded-lg border bg-muted">
                  <img src={aiResult} alt="" className="mx-auto max-h-80 object-contain" />
                </div>
                <Button
                  className="w-full"
                  onClick={() => saveMut.mutate(aiResult)}
                  disabled={saveMut.isPending}
                >
                  {saveMut.isPending ? (
                    <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />保存中…</>
                  ) : (
                    <><Check className="mr-1.5 h-4 w-4" />使用此图</>
                  )}
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="search" className="space-y-3 pt-4">
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索关键词，如：奥特曼软胶"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); searchMut.mutate(); }
                }}
              />
              <Button
                onClick={() => searchMut.mutate()}
                disabled={searchMut.isPending || query.trim().length < 1}
              >
                {searchMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>

            {results.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {results.map((it, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => saveMut.mutate(it.url)}
                    disabled={saveMut.isPending}
                    className="group relative aspect-square overflow-hidden rounded-md border bg-muted transition hover:ring-2 hover:ring-primary disabled:opacity-50"
                    title={it.title}
                  >
                    <img
                      src={it.url}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                      onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
                    />
                  </button>
                ))}
              </div>
            )}
            {saveMut.isPending && (
              <p className="text-center text-xs text-muted-foreground">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />保存所选图片…
              </p>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
