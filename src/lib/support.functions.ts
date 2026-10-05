import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { SUPPORT_QUEUES, SupportError } from "@/lib/support-policy";
import { parseMessageWindow, sanitizeSupportSearch } from "@/lib/support-message-window";

// 错误统一抛出 "[code] 中文说明"，UI 可按 code 判断（例如 version_conflict → 刷新）。

export const listSupportConversationsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        queue: z.enum(SUPPORT_QUEUES, { message: "队列只能是 unclaimed/mine/escalated/closed/all" }).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        q: z.string().max(80, "搜索词不超过 80 字").optional(),
      })
      .optional()
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { resolveSupportAccess, listStaffConversations } =
      await import("@/server/support.server");
    const access = await resolveSupportAccess(context.userId);
    let page;
    try {
      page = await listStaffConversations({
        access,
        queue: data?.queue ?? "all",
        cursor: data?.cursor ?? null,
        limit: data?.limit ?? 50,
        q: sanitizeSupportSearch(data?.q).ok ? (sanitizeSupportSearch(data?.q) as { q: string | null }).q : null,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "invalid_cursor") throw new SupportError("invalid_cursor");
      throw e;
    }
    return {
      items: page.items,
      next_cursor: page.next_cursor,
      queue: page.queue,
      scope: access.is_hq_agent ? "hq_all_conversations" : "assigned_locations",
      agent: { id: access.user_id, name: access.display_name, role: access.participant_role },
    };
  });

const ConversationId = z.string().uuid("会话编号格式不正确");

export const getSupportConversationFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        conversationId: ConversationId,
        locationId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        before: z.string().max(200).optional(),
        after: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const win = parseMessageWindow({ limit: data.limit, before: data.before, after: data.after });
    if (!win.ok) throw new SupportError(win.code);
    const { resolveSupportAccess, getStaffConversation } = await import("@/server/support.server");
    const access = await resolveSupportAccess(context.userId);
    const result = await getStaffConversation(access, data.conversationId, {
      locationId: data.locationId,
      window: win.window,
    });
    if (!result.ok) throw new SupportError(result.code);
    return result.data;
  });

export const sendSupportMessageFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        conversationId: ConversationId,
        body: z.string().trim().min(1, "消息内容不能为空").max(4000, "消息不超过 4000 字"),
        internal: z.boolean(),
        clientOpId: z.string().trim().min(1, "缺少消息编号").max(120),
        // 对外回复必填（服务端缺失时返回 assignment_version_required）；内部备注可省略
        assignmentVersion: z.number().int().min(0).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { resolveSupportAccess, postStaffMessage } = await import("@/server/support.server");
    const access = await resolveSupportAccess(context.userId);
    const result = await postStaffMessage({
      access,
      conversationId: data.conversationId,
      body: data.body,
      internal: data.internal,
      clientOpId: data.clientOpId,
      assignmentVersion: data.assignmentVersion ?? null,
    });
    if (!result.ok) throw new SupportError(result.code, result.detail);
    return result.data;
  });

export const updateSupportAssignmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        conversationId: ConversationId,
        action: z.enum(["claim", "takeover", "close", "reopen"], {
          message: "操作只能是领取、接管、关闭或重开",
        }),
        assignmentVersion: z.number({ message: "缺少会话版本，请刷新" }).int().min(0),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { resolveSupportAccess, updateConversationAssignment } =
      await import("@/server/support.server");
    const access = await resolveSupportAccess(context.userId);
    const result = await updateConversationAssignment({
      access,
      conversationId: data.conversationId,
      action: data.action,
      assignmentVersion: data.assignmentVersion,
    });
    if (!result.ok) throw new SupportError(result.code, result.detail);
    return result.data;
  });

/** 超时升级手动/外部 worker 触发：仅 super_admin / hq_operator。不自动排程。 */
export const runSupportEscalationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadUserRoles } = await import("@/server/handheld-auth.server");
    const roles = await loadUserRoles(context.userId);
    if (!roles.includes("super_admin") && !roles.includes("hq_operator")) {
      throw new SupportError("forbidden");
    }
    const { runSupportEscalation } = await import("@/server/support.server");
    return runSupportEscalation(60, 180);
  });
