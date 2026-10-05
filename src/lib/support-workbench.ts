export type SupportFilter = "all" | "waiting" | "mine" | "escalated" | "closed";

export function supportRetryKey(conversationId: string, body: string, internal: boolean): string {
  return JSON.stringify([conversationId, internal, body.trim()]);
}

type Assignment = {
  status: string;
  primary_agent_id?: string | null;
  assignment_version?: number;
  channel?: string;
  can_reply?: boolean;
  can_note?: boolean;
};

export function supportReplyPermission(
  conversation: Assignment | null | undefined,
  agentId: string | undefined,
  internal: boolean,
): { allowed: boolean; reason: string } {
  if (!conversation) return { allowed: false, reason: "正在读取会话，请稍候" };
  if (conversation.status === "closed")
    return { allowed: false, reason: "会话已解决，重新打开后可继续处理" };
  if (!Number.isInteger(conversation.assignment_version))
    return { allowed: false, reason: "接待信息未就绪，请刷新" };
  if (internal)
    return {
      allowed: conversation.can_note === true,
      reason: conversation.can_note ? "仅同事可见，不发送给顾客" : "没有备注权限",
    };
  if (conversation.channel === "wechat_kf")
    return { allowed: false, reason: "微信渠道尚未连通，暂不能对外发送" };
  if (!conversation.primary_agent_id) return { allowed: false, reason: "先点击接待，再回复顾客" };
  if (!agentId || conversation.primary_agent_id !== agentId)
    return { allowed: false, reason: "当前由其他同事接待，可添加内部备注" };
  if (conversation.can_reply !== true)
    return { allowed: false, reason: "暂不能回复，请刷新接待信息" };
  return { allowed: true, reason: "回复将发送到顾客的原会话" };
}

export function filterSupportConversations<T extends Assignment & { escalated_at?: string | null }>(
  rows: T[],
  filter: SupportFilter,
  agentId?: string,
): T[] {
  return rows.filter((row) => {
    if (filter === "closed") return row.status === "closed";
    if (filter === "all") return true;
    if (row.status === "closed") return false;
    if (filter === "waiting") return !row.primary_agent_id;
    if (filter === "mine") return Boolean(agentId && row.primary_agent_id === agentId);
    return Boolean(row.escalated_at);
  });
}

export function supportChannelLabel(channel?: string): string {
  if (channel === "wechat_kf") return "微信客服";
  if (channel === "app") return "APP";
  if (channel === "mini") return "小程序";
  return "商城消息";
}

export function supportErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    assignment_conflict: "接待人已变更，请刷新后继续；草稿已保留",
    version_conflict: "接待人已变更，请刷新后继续；草稿已保留",
    assignment_version_required: "接待信息未就绪，请刷新后继续；草稿已保留",
    stale_assignment: "接待信息已更新，请刷新后继续；草稿已保留",
    not_primary_agent: "当前由其他同事接待，请先接管或改写内部备注",
    forbidden: "没有此会话的访问权限",
    forbidden_location: "没有此门店的客服权限",
    conversation_closed: "会话已解决，重新打开后可继续处理",
    not_found: "会话不存在或无权访问，请刷新列表",
    channel_not_connected: "微信渠道尚未连通，草稿已保留",
    invalid_body: "消息内容或接待信息不完整，请刷新后重试",
  };
  const known = Object.keys(messages).find((key) => code.includes(key));
  if (known) return messages[known];
  return /[\u4e00-\u9fff]/.test(code) ? code : "操作未成功，请刷新重试；草稿已保留";
}
