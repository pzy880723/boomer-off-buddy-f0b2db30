import { createFileRoute } from "@tanstack/react-router";
import { handleParcelMediaUpload } from "@/server/parcel-media-upload.server";

export const Route = createFileRoute("/api/internal/media/parcel-upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { tencentMediaUploader } = await import("@/server/tencent-media-client.server");
        return handleParcelMediaUpload(request, {
          getUploader: tencentMediaUploader,
          async authenticate(token) {
            const { data, error } = await supabaseAdmin.auth.getUser(token);
            if (error || !data.user) return null;
            const user = data.user as { id: string; is_anonymous?: boolean };
            return { id: user.id, isAnonymous: user.is_anonymous === true };
          },
          uuid: () => crypto.randomUUID(),
        });
      },
    },
  },
});
