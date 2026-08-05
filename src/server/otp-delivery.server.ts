import type { SendOtpResult } from "./sms.tencent.server";

type DeliverStoredOtpOptions = {
  send: () => Promise<SendOtpResult>;
  removeStoredOtp: () => Promise<void>;
};

export async function deliverStoredOtp({
  send,
  removeStoredOtp,
}: DeliverStoredOtpOptions): Promise<SendOtpResult> {
  const result = await send();
  if (!result.ok) await removeStoredOtp();
  return result;
}
