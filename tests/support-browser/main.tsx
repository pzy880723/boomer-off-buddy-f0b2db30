import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  SupportWorkbench,
  type WorkbenchConversation,
  type WorkbenchMessage,
  type AssignmentAction,
} from "../../src/components/support-workbench";
import type { SupportFilter } from "../../src/lib/support-workbench";
import "../../src/styles.css";

const initial: WorkbenchConversation[] = [
  {
    id: "demo-1",
    title: "三丽鸥双子星收纳盒咨询",
    customer_name: "演示顾客甲",
    location_name: "新天地店",
    status: "open",
    channel: "native",
    assignment_version: 0,
    primary_agent_id: null,
    primary_agent_name: null,
    unread_count: 1,
    last_message: "请问抽屉内侧有划痕吗？",
    context: { title: "三丽鸥双子星粉色双层收纳盒", barcode: "DEMO-001" },
  },
  {
    id: "demo-2",
    title: "易碎品打包咨询",
    customer_name: "演示顾客乙",
    location_name: "中信泰富店",
    status: "open",
    channel: "native",
    assignment_version: 1,
    primary_agent_id: "store-a",
    primary_agent_name: "门店客服",
    escalated_at: "2026-10-05T10:00:00Z",
    last_message: "玻璃杯可以寄外地吗？",
  },
  {
    id: "demo-3",
    title: "微信渠道未配置",
    location_name: "总部",
    status: "open",
    channel: "wechat_kf",
    assignment_version: 0,
    primary_agent_id: null,
  },
];

function Preview() {
  const [items, setItems] = useState(initial);
  const [activeId, setActiveId] = useState("demo-1");
  const [filter, setFilter] = useState<SupportFilter>("all");
  const [drafts, setDrafts] = useState<Record<string, { body: string; internal: boolean }>>({});
  const [messages, setMessages] = useState<Record<string, WorkbenchMessage[]>>({
    "demo-1": [
      {
        id: "m1",
        sender_name: "演示顾客甲",
        sender_type: "customer",
        body: "请问抽屉内侧有划痕吗？能帮我拍一张细节图吗？",
        internal: false,
        created_at: "2026-10-05T10:00:00Z",
      },
    ],
  });
  const current = items.find((item) => item.id === activeId)!;
  const draft = drafts[activeId] ?? { body: "", internal: false };
  const update = (patch: Partial<typeof draft>) =>
    setDrafts((old) => ({
      ...old,
      [activeId]: { ...(old[activeId] ?? { body: "", internal: false }), ...patch },
    }));
  const assignment = (action: AssignmentAction) =>
    setItems((old) =>
      old.map((item) =>
        item.id !== activeId
          ? item
          : {
              ...item,
              assignment_version: (item.assignment_version ?? 0) + 1,
              ...(action === "claim" || action === "takeover"
                ? { primary_agent_id: "hq", primary_agent_name: "总部客服" }
                : {}),
              ...(action === "close"
                ? { status: "closed" }
                : action === "reopen"
                  ? { status: "open" }
                  : {}),
            },
      ),
    );
  const send = () => {
    setMessages((old) => ({
      ...old,
      [activeId]: [
        ...(old[activeId] ?? []),
        {
          id: crypto.randomUUID(),
          sender_name: "总部客服",
          sender_type: "staff",
          sender_role: "hq_agent",
          body: draft.body,
          internal: draft.internal,
          created_at: new Date().toISOString(),
          delivery_status: "sent",
        },
      ],
    }));
    update({ body: "" });
  };
  return (
    <main className="mx-auto max-w-[1480px] space-y-4 p-4 md:p-6">
      <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        交互检查：实际工作台组件 + 合成数据，不连接真实客户，不代表微信已打通。
      </div>
      <div>
        <h1 className="text-2xl font-semibold">客服工作台</h1>
        <p className="mt-1 text-sm text-muted-foreground">总部客服 · 全部门店</p>
      </div>
      <SupportWorkbench
        items={items}
        agentId="hq"
        isHq
        activeId={activeId}
        detail={{
          conversation: current,
          messages: messages[activeId] ?? [],
          can_reply: current.status !== "closed" && current.primary_agent_id === "hq",
          can_note: true,
        }}
        filter={filter}
        draft={draft.body}
        internal={draft.internal}
        listLoading={false}
        detailLoading={false}
        refreshing={false}
        sending={false}
        changingAssignment={false}
        onFilter={setFilter}
        onSelect={setActiveId}
        onDraft={(body) => update({ body })}
        onInternal={(internal) => update({ internal })}
        onRefresh={() => {}}
        onSend={send}
        onAssignment={assignment}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
