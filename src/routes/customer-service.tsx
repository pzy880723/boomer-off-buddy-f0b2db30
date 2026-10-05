import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { SupportWorkbench, type AssignmentAction } from "@/components/support-workbench";
import { supportErrorMessage, supportRetryKey, type SupportFilter } from "@/lib/support-workbench";
import { useAuthSession } from "@/hooks/use-auth-session";
import {
  getSupportConversationFn,
  listSupportConversationsFn,
  sendSupportMessageFn,
  updateSupportAssignmentFn,
} from "@/lib/support.functions";

export const Route = createFileRoute("/customer-service")({
  head: () => ({
    meta: [
      { title: "客服工作台 | BOOMER ERP" },
      { name: "description", content: "门店优先接待，总部同会话接管，统一处理顾客咨询。" },
    ],
  }),
  component: CustomerServicePage,
});

type Draft = { body: string; internal: boolean };
type Reply = {
  conversationId: string;
  body: string;
  internal: boolean;
  clientOpId: string;
  assignmentVersion: number;
};

function CustomerServicePage() {
  const { session } = useAuthSession();
  if (!session?.user.id) return <PageHeader title="客服工作台" description="正在确认登录身份…" />;
  return <CustomerServiceSession key={session.user.id} userId={session.user.id} />;
}

function CustomerServiceSession({ userId }: { userId: string }) {
  const listFn = useServerFn(listSupportConversationsFn);
  const detailFn = useServerFn(getSupportConversationFn);
  const sendFn = useServerFn(sendSupportMessageFn);
  const assignmentFn = useServerFn(updateSupportAssignmentFn);
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState<SupportFilter>("all");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const pendingReplies = useRef(new Map<string, string>());

  const queue = filter === "waiting" ? "unclaimed" : filter;
  const listQuery = useInfiniteQuery({
    queryKey: ["support-conversations", userId, queue],
    initialPageParam: "",
    queryFn: ({ pageParam }) => listFn({ data: { queue, cursor: pageParam || undefined } }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: 10_000,
  });
  const listMeta = listQuery.data?.pages[0];
  const seen = new Set<string>();
  const items = (listQuery.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const currentId =
    activeId && items.some((item) => item.id === activeId) ? activeId : (items[0]?.id ?? null);
  const draft = currentId
    ? (drafts[currentId] ?? { body: "", internal: false })
    : { body: "", internal: false };
  const detailQuery = useQuery({
    queryKey: ["support-conversation", userId, currentId],
    queryFn: () => detailFn({ data: { conversationId: currentId! } }),
    enabled: Boolean(currentId),
    refetchInterval: 5_000,
  });

  function updateDraft(patch: Partial<Draft>) {
    if (!currentId) return;
    setDrafts((old) => ({
      ...old,
      [currentId]: { ...(old[currentId] ?? { body: "", internal: false }), ...patch },
    }));
  }

  function invalidate(id?: string) {
    void queryClient.invalidateQueries({
      queryKey: id ? ["support-conversation", userId, id] : ["support-conversation", userId],
    });
    void queryClient.invalidateQueries({ queryKey: ["support-conversations", userId] });
  }

  const sendMutation = useMutation({
    mutationFn: (reply: Reply) => sendFn({ data: reply }),
    onSuccess: (_result, reply) => {
      pendingReplies.current.delete(
        supportRetryKey(reply.conversationId, reply.body, reply.internal),
      );
      setDrafts((old) => {
        const current = old[reply.conversationId];
        if (!current || current.body.trim() !== reply.body || current.internal !== reply.internal)
          return old;
        return { ...old, [reply.conversationId]: { ...current, body: "" } };
      });
      invalidate(reply.conversationId);
    },
    onError: (error: Error, reply) => {
      toast.error(supportErrorMessage(error.message));
      invalidate(reply.conversationId);
    },
  });

  const assignmentMutation = useMutation({
    mutationFn: (data: {
      conversationId: string;
      action: AssignmentAction;
      assignmentVersion: number;
    }) => assignmentFn({ data }),
    onSuccess: (_result, data) => invalidate(data.conversationId),
    onError: (error: Error, data) => {
      toast.error(supportErrorMessage(error.message));
      invalidate(data.conversationId);
    },
  });

  function send() {
    const version = detailQuery.data?.conversation.assignment_version;
    if (!currentId || !draft.body.trim() || !Number.isInteger(version) || sendMutation.isPending)
      return;
    const key = supportRetryKey(currentId, draft.body, draft.internal);
    // Unknown outcomes retain their operation id, including after close/reopen changes the version.
    const reply = {
      conversationId: currentId,
      body: draft.body.trim(),
      internal: draft.internal,
      assignmentVersion: version!,
      clientOpId: pendingReplies.current.get(key) ?? crypto.randomUUID(),
    };
    pendingReplies.current.set(key, reply.clientOpId);
    sendMutation.mutate(reply);
  }

  function assignment(action: AssignmentAction) {
    const version = detailQuery.data?.conversation.assignment_version;
    if (!currentId || !Number.isInteger(version) || assignmentMutation.isPending) return;
    assignmentMutation.mutate({ conversationId: currentId, action, assignmentVersion: version! });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="客服工作台"
        description={
          listMeta
            ? `${listMeta.agent.name} · ${listMeta.scope === "hq_all_conversations" ? "总部客服 · 全部门店" : "门店客服 · 授权门店"}`
            : "统一处理商城与门店咨询"
        }
      />
      <SupportWorkbench
        items={items}
        agentId={listMeta?.agent.id}
        isHq={listMeta?.scope === "hq_all_conversations"}
        activeId={currentId}
        detail={detailQuery.data ?? null}
        filter={filter}
        draft={draft.body}
        internal={draft.internal}
        listLoading={listQuery.isLoading}
        detailLoading={detailQuery.isLoading}
        listError={listQuery.error ? supportErrorMessage(listQuery.error.message) : undefined}
        detailError={detailQuery.error ? supportErrorMessage(detailQuery.error.message) : undefined}
        refreshing={listQuery.isFetching || detailQuery.isFetching}
        sending={sendMutation.isPending}
        changingAssignment={assignmentMutation.isPending}
        onFilter={setFilter}
        onSelect={setActiveId}
        onDraft={(body) => updateDraft({ body })}
        onInternal={(internal) => updateDraft({ internal })}
        onRefresh={() => invalidate()}
        onSend={send}
        onAssignment={assignment}
        hasMore={listQuery.hasNextPage}
        loadingMore={listQuery.isFetchingNextPage}
        onLoadMore={() => void listQuery.fetchNextPage()}
      />
    </div>
  );
}
