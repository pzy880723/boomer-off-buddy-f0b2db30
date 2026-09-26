import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CustomTransferRequest } from "@/lib/custom-transfer-contract";

export const customTransfers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CustomTransferRequest.parse(input))
  .handler(async ({ context, data }) => {
    const { executeCustomTransfer, CustomTransferError } =
      await import("@/server/custom-transfers.server");
    try {
      return await executeCustomTransfer(context.userId, data);
    } catch (error) {
      if (error instanceof CustomTransferError && error.status < 500)
        return { error: { code: error.code, message: error.message } };
      throw error;
    }
  });
