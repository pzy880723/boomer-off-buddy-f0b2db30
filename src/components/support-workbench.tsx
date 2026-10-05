import {
  Loader2,
  Lock,
  MessageSquare,
  RefreshCw,
  Send,
  UserRound,
  Store,
  Headphones,
  Bell,
} from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  filterSupportConversations,
  supportChannelLabel,
  supportReplyPermission,
  type SupportFilter,
} from "@/lib/support-workbench";

export type WorkbenchConversation = {
  id: string;
  title: string | null;
  customer_name?: string | null;
  location_name?: string | null;
  last_message?: string | null;
  unread_count?: number;
  status: string;
  channel?: string;
  primary_agent_id?: string | null;
  primary_agent_name?: string | null;
  assignment_version?: number;
  escalated_at?: string | null;
  order_id?: string | null;
  topic?: string;
  context?: Record<string, unknown> | null;
};

export type WorkbenchMessage = {
  id: string;
  sender_name: string;
  sender_type: string;
  body: string;
  internal: boolean;
  created_at: string;
  delivery_status?: string | null;
  sender_avatar_url?: string | null;
  sender_role?: string;
  sender_location_name?: string | null;
};

export type AssignmentAction = "claim" | "takeover" | "close" | "reopen";

export type SupportWorkbenchProps = {
  items: WorkbenchConversation[];
  agentId?: string;
  isHq: boolean;
  activeId: string | null;
  detail: {
    conversation: WorkbenchConversation;
    messages: WorkbenchMessage[];
    can_reply: boolean;
    can_note?: boolean;
    has_more?: boolean;
  } | null;
  filter: SupportFilter;
  draft: string;
  internal: boolean;
  listLoading: boolean;
  detailLoading: boolean;
  listError?: string;
  detailError?: string;
  refreshing: boolean;
  sending: boolean;
  changingAssignment: boolean;
  onFilter: (filter: SupportFilter) => void;
  onSelect: (id: string) => void;
  onDraft: (text: string) => void;
  onInternal: (internal: boolean) => void;
  onRefresh: () => void;
  onSend: () => void;
  onAssignment: (action: AssignmentAction) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
};

function MessageAvatar({ message }: { message: WorkbenchMessage }) {
  const role =
    message.sender_role ?? (message.sender_type === "customer" ? "customer" : "store_staff");
  const Icon =
    role === "customer"
      ? UserRound
      : role === "hq_agent"
        ? Headphones
        : role === "system"
          ? Bell
          : Store;
  const label =
    role === "customer"
      ? "客户头像"
      : role === "hq_agent"
        ? "总部客服头像"
        : role === "system"
          ? "系统通知"
          : `${message.sender_location_name || "门店"}客服头像`;
  const url = message.sender_avatar_url?.startsWith("https://")
    ? message.sender_avatar_url
    : undefined;
  return (
    <Avatar className="h-9 w-9 shrink-0" aria-label={label}>
      <AvatarImage src={url} alt={label} />
      <AvatarFallback className={cn(role !== "customer" && "bg-primary text-primary-foreground")}>
        <Icon className="h-4 w-4" />
      </AvatarFallback>
    </Avatar>
  );
}

const filters: { value: SupportFilter; label: string }[] = [
  { value: "waiting", label: "待接待" },
  { value: "mine", label: "我接待的" },
  { value: "escalated", label: "总部跟进" },
  { value: "closed", label: "已解决" },
  { value: "all", label: "全部" },
];

function contextText(
  context: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = context?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function SupportWorkbench(props: SupportWorkbenchProps) {
  const rows = filterSupportConversations(props.items, props.filter, props.agentId);
  const detail = props.detail?.conversation.id === props.activeId ? props.detail : null;
  const conversation = detail?.conversation;
  const permission = supportReplyPermission(
    conversation
      ? { ...conversation, can_reply: detail?.can_reply, can_note: detail?.can_note }
      : null,
    props.agentId,
    props.internal,
  );
  const mine = Boolean(props.agentId && conversation?.primary_agent_id === props.agentId);
  const closed = conversation?.status === "closed";
  const versionReady = Number.isInteger(conversation?.assignment_version);
  const canManage = versionReady && (mine || props.isHq);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          门店优先接待，总部同会话接管；内部备注仅同事可见。
        </p>
        <Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.refreshing}>
          <RefreshCw className={cn("mr-2 h-4 w-4", props.refreshing && "animate-spin")} /> 刷新
        </Button>
      </div>
      <div className="grid items-start gap-3 xl:grid-cols-[280px_minmax(0,1fr)_250px] lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardContent className="p-3">
            <div className="mb-3 flex flex-wrap gap-1" aria-label="会话筛选">
              {filters
                .filter((item) => props.isHq || item.value !== "escalated")
                .map((item) => (
                  <Button
                    key={item.value}
                    variant={props.filter === item.value ? "default" : "ghost"}
                    size="sm"
                    onClick={() => props.onFilter(item.value)}
                    aria-pressed={props.filter === item.value}
                  >
                    {item.label}
                  </Button>
                ))}
            </div>
            <div className="max-h-[38vh] space-y-1 overflow-y-auto lg:h-[65vh] lg:max-h-none">
              {props.listLoading ? (
                <p className="flex items-center justify-center p-6 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在加载会话
                </p>
              ) : props.listError ? (
                <p role="alert" className="p-3 text-sm text-destructive">
                  {props.listError}，请刷新重试
                </p>
              ) : rows.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">此分组暂无会话</p>
              ) : (
                rows.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => props.onSelect(item.id)}
                    aria-pressed={item.id === props.activeId}
                    className={cn(
                      "w-full rounded-lg border border-transparent p-3 text-left transition-colors hover:bg-muted",
                      item.id === props.activeId && "border-border bg-muted",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">
                        {item.customer_name || item.title || "顾客咨询"}
                      </span>
                      {Boolean(item.unread_count) && (
                        <Badge variant="destructive">{item.unread_count}</Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {item.last_message || "暂无消息"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <span>{item.location_name || "总部"}</span>
                      <span>· {supportChannelLabel(item.channel)}</span>
                      {item.escalated_at && item.status !== "closed" && (
                        <Badge variant="outline" className="text-[10px]">
                          总部跟进
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {item.status === "closed"
                        ? "已解决"
                        : item.primary_agent_name ||
                          (item.primary_agent_id ? "已分配接待人" : "待接待")}
                    </p>
                  </button>
                ))
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              当前已加载 {props.items.length} 条会话 · 刷新后更新
            </p>
            {props.hasMore && (
              <Button
                variant="outline"
                className="mt-2 w-full"
                onClick={props.onLoadMore}
                disabled={props.loadingMore}
              >
                {" "}
                {props.loadingMore ? "读取中…" : "加载更多会话"}{" "}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-w-0 flex-col">
          <CardContent className="flex min-h-[65vh] flex-col gap-3 p-4 lg:h-[calc(65vh+100px)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">
                  {conversation?.customer_name || conversation?.title || "顾客会话"}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {conversation
                    ? `${conversation.location_name || "总部"} · ${supportChannelLabel(conversation.channel)} · ${closed ? "已解决" : conversation.primary_agent_name || "待接待"}`
                    : "选择会话查看内容"}
                </p>
              </div>
              {conversation && (
                <div className="flex flex-wrap gap-2">
                  {!closed && !conversation.primary_agent_id && (
                    <Button
                      size="sm"
                      disabled={!versionReady || props.changingAssignment}
                      onClick={() => props.onAssignment("claim")}
                    >
                      <UserRound className="mr-1 h-4 w-4" />
                      接待
                    </Button>
                  )}
                  {!closed && conversation.primary_agent_id && !mine && props.isHq && (
                    <Button
                      size="sm"
                      disabled={!versionReady || props.changingAssignment}
                      onClick={() => props.onAssignment("takeover")}
                    >
                      总部接管
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={props.changingAssignment}
                      onClick={() => props.onAssignment(closed ? "reopen" : "close")}
                    >
                      {closed ? "重新打开" : "标记已解决"}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div
              className="min-h-[180px] flex-1 space-y-3 overflow-y-auto pr-1"
              aria-label="消息记录"
            >
              {props.detailError ? (
                <p role="alert" className="text-sm text-destructive">
                  {props.detailError}，请刷新重试
                </p>
              ) : props.detailLoading && !detail ? (
                <p className="flex items-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在读取消息
                </p>
              ) : !detail ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <MessageSquare className="mr-2 h-4 w-4" />
                  选择左侧会话开始接待
                </div>
              ) : detail.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无消息，可以先添加内部备注。</p>
              ) : (
                <>
                  {detail.has_more && (
                    <p className="text-xs text-muted-foreground">
                      仅显示最近 500 条消息，更早的历史暂未加载
                    </p>
                  )}
                  {detail.messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        "flex items-start gap-2",
                        message.sender_type === "staff" && "flex-row-reverse",
                      )}
                    >
                      <MessageAvatar message={message} />
                      <div
                        className={cn(
                          "min-w-0 max-w-[88%] rounded-lg border p-3",
                          message.sender_type === "customer" ? "bg-muted/50" : "bg-background",
                          message.internal && "border-dashed border-amber-500/40 bg-amber-500/5",
                        )}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{message.sender_name}</span>
                          <time dateTime={message.created_at}>
                            {new Date(message.created_at).toLocaleString("zh-CN", {
                              timeZone: "Asia/Shanghai",
                            })}
                          </time>
                          {message.internal && (
                            <Badge variant="outline" className="gap-1">
                              <Lock className="h-3 w-3" />
                              内部备注
                            </Badge>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                        {message.sender_type === "staff" &&
                          !message.internal &&
                          message.delivery_status && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {(
                                {
                                  queued: "排队中",
                                  pending: "待发送 · 渠道尚未连通",
                                  sending: "发送中",
                                  accepted: "平台已接受",
                                  failed: "发送失败",
                                  uncertain: "发送结果待核查",
                                  sent: "已保存到顾客会话",
                                  delivered: "已发送",
                                } as Record<string, string>
                              )[message.delivery_status] || "投递状态待核查"}
                            </p>
                          )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="space-y-2 border-t pt-3">
              <Textarea
                aria-label={props.internal ? "内部备注内容" : "回复顾客内容"}
                value={props.draft}
                onChange={(event) => props.onDraft(event.target.value)}
                placeholder={props.internal ? "输入内部备注，不发送给顾客…" : "回复顾客…"}
                rows={3}
                maxLength={4000}
                disabled={!detail || props.detailLoading}
              />
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {permission.reason}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Switch
                    id="support-internal"
                    checked={props.internal}
                    onCheckedChange={props.onInternal}
                  />
                  <Label htmlFor="support-internal" className="text-sm">
                    内部备注
                  </Label>
                </div>
                <Button
                  onClick={props.onSend}
                  disabled={
                    !permission.allowed ||
                    !props.draft.trim() ||
                    props.sending ||
                    props.changingAssignment ||
                    props.detailLoading
                  }
                >
                  {props.sending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-4 w-4" />
                  )}
                  {props.internal ? "保存备注" : "发送回复"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 lg:col-start-2 xl:col-start-auto">
          <CardContent className="space-y-4 p-4">
            <h2 className="text-sm font-semibold">咨询信息</h2>
            {!conversation ? (
              <p className="text-xs text-muted-foreground">选择会话后显示商品与订单上下文。</p>
            ) : (
              <>
                <div>
                  <p className="text-xs text-muted-foreground">对应门店</p>
                  <p className="mt-1 text-sm">{conversation.location_name || "总部"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">主接待人</p>
                  <p className="mt-1 text-sm">
                    {conversation.primary_agent_name ||
                      (conversation.primary_agent_id ? "已分配接待人" : "尚未领取")}
                  </p>
                </div>
                {conversation.escalated_at && !closed && (
                  <p className="rounded-md bg-muted p-2 text-xs">
                    此会话需要总部跟进。接管不改变商品和订单的门店归属。
                  </p>
                )}
                <div>
                  <p className="text-xs text-muted-foreground">咨询主题</p>
                  <p className="mt-1 break-words text-sm">{conversation.topic || "一般咨询"}</p>
                </div>
                {contextText(conversation.context, "title", "name", "order_no") && (
                  <div>
                    <p className="text-xs text-muted-foreground">关联商品 / 订单</p>
                    <p className="mt-1 break-words text-sm">
                      {contextText(conversation.context, "title", "name", "order_no")}
                    </p>
                  </div>
                )}
                {contextText(conversation.context, "barcode", "sku_code") && (
                  <div>
                    <p className="text-xs text-muted-foreground">商品编码</p>
                    <p className="mt-1 break-all font-mono text-xs">
                      {contextText(conversation.context, "barcode", "sku_code")}
                    </p>
                  </div>
                )}
                {!conversation.context && !conversation.order_id && (
                  <p className="text-xs text-muted-foreground">此会话没有关联商品或订单。</p>
                )}
                {conversation.order_id && (
                  <div>
                    <p className="text-xs text-muted-foreground">关联订单 ID</p>
                    <p className="mt-1 break-all font-mono text-xs">{conversation.order_id}</p>
                  </div>
                )}
                <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
                  不要在聊天中直接修改库存或退款。门店只能处理授权范围内的会话，总部可协助接管。
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
