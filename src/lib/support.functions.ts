import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listSupportConversationsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { resolveSupportAccess, listStaffConversations } =
      await import("@/server/support.server");
    const access = await resolveSupportAccess(context.userId);
    const page = await listStaffConversations({ access, limit: 50 });
    return {
      items: page.items,
      scope: access.is_hq_agent ? "hq_all_conversations" : "assigned_locations",
      agent: { name: access.display_name, role: access.participant_role },
    };
  });

export const getSupportConversationFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { conversationId: string }) => input)
  .handler(async ({ data, context }) => {
    const { resolveSupportAccess, getStaffConversation } = await import("@/server/support.server");
    const access = await resolveSupportAccess(context.userId);
    const result = await getStaffConversation(access, data.conversationId);
    if (!result.ok) throw new Error(result.code);
    return result.data;
  });

export const sendSupportMessageFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { conversationId: string; body: string; internal: boolean; clientOpId: string }) =>
      input,
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
    });
    if (!result.ok) throw new Error(result.code);
    return result.data;
  });
