import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  getSupportConversationFn,
  listSupportConversationsFn,
  sendSupportMessageFn,
} from "@/lib/support.functions";

export const Route = createFileRoute("/customer-service")({
  head: () => ({
    meta: [
      { title: "客服工作台 | BOOMER ERP" },
      {
        name: "description",
        content: "门店与总部客服共享同一顾客会话，实时协同回复顾客咨询与缺货确认。",
      },
      { property: "og:title", content: "客服工作台 | BOOMER ERP" },
      {
        property: "og:description",
        content: "门店与总部客服共享同一顾客会话，实时协同回复顾客咨询与缺货确认。",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CustomerServicePage,
});

function CustomerServicePage() {
  const listFn = useServerFn(listSupportConversationsFn);
  const detailFn = useServerFn(getSupportConversationFn);
  const sendFn = useServerFn(sendSupportMessageFn);
  const queryClient = useQueryClient();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [internal, setInternal] = useState(false);

  const listQuery = useQuery({
    queryKey: ["support-conversations"],
    queryFn: () => listFn(),
    refetchInterval: 15_000,
  });

  const conversations = listQuery.data?.items ?? [];
  const currentId = activeId ?? conversations[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ["support-conversation", currentId],
    queryFn: () => detailFn({ data: { conversationId: currentId! } }),
    enabled: Boolean(currentId),
    refetchInterval: 10_000,
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!currentId || !draft.trim()) return null;
      return sendFn({
        data: {
          conversationId: currentId,
          body: draft.trim(),
          internal,
          clientOpId: crypto.randomUUID(),
        },
      });
    },
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["support-conversation", currentId] });
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
    onError: (error: Error) => toast.error(error.message || "发送失败"),
  });

  const messages = useMemo(() => detailQuery.data?.messages ?? [], [detailQuery.data]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="客服工作台"
        description={
          listQuery.data
            ? `${listQuery.data.agent.name} · ${listQuery.data.scope === "hq_all_conversations" ? "总部客服（全部门店会话）" : "门店客服"}`
            : "门店与总部客服共享接待，同一会话可同时回复"
        }
      />

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="h-[70vh] overflow-y-auto">
          <CardContent className="p-2">
            {listQuery.isLoading ? (
              <div className="flex items-center justify-center p-6 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 载入中
              </div>
            ) : conversations.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">暂无会话</p>
            ) : (
              conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveId(item.id)}
                  className={cn(
                    "w-full rounded-md p-3 text-left transition-colors hover:bg-muted",
                    item.id === currentId && "bg-muted",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {item.customer_name ?? item.title ?? "顾客"}
                    </span>
                    {item.unread_count > 0 ? (
                      <Badge variant="destructive">{item.unread_count}</Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.last_message ?? "暂无消息"}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {item.location_name ?? "未指定门店"} ·{" "}
                    {item.participants.map((p) => p.name).join("、") || "尚无接待人"}
                  </p>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="flex h-[70vh] flex-col">
          <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
            <div className="flex-1 space-y-3 overflow-y-auto pr-1">
              {!currentId ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <MessageSquare className="mr-2 h-4 w-4" /> 选择左侧会话开始接待
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "rounded-lg border p-3",
                      message.sender_type === "customer" ? "bg-muted/50" : "bg-background",
                      message.internal && "border-dashed border-amber-500/60 bg-amber-500/5",
                    )}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{message.sender_name}</span>
                      <span>{new Date(message.created_at).toLocaleString("zh-CN")}</span>
                      {message.internal ? (
                        <Badge variant="outline" className="gap-1">
                          <Lock className="h-3 w-3" /> 内部备注（顾客不可见）
                        </Badge>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{message.body}</p>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-2 border-t pt-3">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={internal ? "输入内部备注，仅同事可见" : "回复顾客…"}
                rows={3}
                disabled={!currentId || detailQuery.data?.can_reply === false}
              />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch id="internal" checked={internal} onCheckedChange={setInternal} />
                  <Label htmlFor="internal" className="text-sm">
                    内部备注
                  </Label>
                </div>
                <Button
                  onClick={() => sendMutation.mutate()}
                  disabled={
                    !currentId ||
                    !draft.trim() ||
                    sendMutation.isPending ||
                    detailQuery.data?.can_reply === false
                  }
                >
                  {sendMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-4 w-4" />
                  )}
                  发送
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
