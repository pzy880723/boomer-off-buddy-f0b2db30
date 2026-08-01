import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

type PaymentAdminContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

const PAYMENT_ADMIN_ROLES = new Set(["super_admin", "hq_operator"]);

async function assertPaymentAdmin(context: PaymentAdminContext) {
  const { data, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  if (error) throw new Error(error.message);
  const roles = ((data ?? []) as Array<{ role: string }>).map((row) => row.role);
  if (!roles.some((role) => PAYMENT_ADMIN_ROLES.has(role))) {
    throw new Response("仅总部管理员可配置门店支付主体", { status: 403 });
  }
}

const SubjectInput = z.object({
  location_id: z.string().uuid(),
  subject_type: z.enum(["enterprise", "individual_business"]),
  legal_name: z.string().trim().min(2).max(120),
  unified_social_credit_code: z.string().trim().min(15).max(30),
  legal_representative_name: z.string().trim().min(2).max(60),
  contact_name: z.string().trim().min(2).max(60),
  contact_phone: z
    .string()
    .trim()
    .regex(/^1\d{10}$/),
  business_license_storage_path: z.string().trim().max(500).nullable().optional(),
});

const SubjectIdInput = z.object({ subject_id: z.string().uuid() });

const ReviewInput = SubjectIdInput.extend({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

const ProviderInput = SubjectIdInput.extend({
  status: z.enum(["not_applied", "applying", "active", "rejected", "suspended"]),
  provider_application_id: z.string().trim().max(100).nullable().optional(),
  wechat_sub_mchid: z.string().trim().max(50).nullable().optional(),
  wechat_appid: z.string().trim().max(50).nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

type LocationRow = { id: string; name: string; kind: "warehouse" | "shop"; is_active: boolean };
type ProfileRow = {
  id: string;
  location_id: string;
  subject_id: string | null;
  payment_code: string;
  status: "setup_required" | "pending" | "active" | "disabled";
  is_enabled: boolean;
  updated_at: string;
};
type SubjectRow = {
  id: string;
  subject_code: string;
  subject_type: "enterprise" | "individual_business";
  legal_name: string;
  unified_social_credit_code: string;
  legal_representative_name: string;
  contact_name: string;
  contact_phone: string;
  business_license_storage_path: string | null;
  erp_verification_status: "draft" | "pending" | "approved" | "rejected";
  erp_verification_note: string | null;
  provider_application_status: "not_applied" | "applying" | "active" | "rejected" | "suspended";
  provider_application_id: string | null;
  wechat_sub_mchid: string | null;
  wechat_appid: string | null;
  provider_status_note: string | null;
  updated_at: string;
};

export type StorePaymentOverview = {
  location: LocationRow;
  profile: ProfileRow | null;
  subject: SubjectRow | null;
  ready_for_payment: boolean;
};

async function listStorePaymentOverview() {
  const [{ data: locations, error: locationError }, { data: profiles, error: profileError }] =
    await Promise.all([
      supabaseAdmin
        .from("inv_locations")
        .select("id,name,kind,is_active")
        .eq("kind", "shop")
        .eq("is_active", true)
        .order("name"),
      supabaseAdmin
        .from("store_payment_profiles" as never)
        .select("id,location_id,subject_id,payment_code,status,is_enabled,updated_at"),
    ]);
  if (locationError) throw new Error(locationError.message);
  if (profileError) throw new Error(profileError.message);

  const profileRows = (profiles ?? []) as unknown as ProfileRow[];
  const subjectIds = [
    ...new Set(
      profileRows.map((profile) => profile.subject_id).filter((id): id is string => Boolean(id)),
    ),
  ];
  let subjects: SubjectRow[] = [];
  if (subjectIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("payment_subjects" as never)
      .select(
        "id,subject_code,subject_type,legal_name,unified_social_credit_code,legal_representative_name,contact_name,contact_phone,business_license_storage_path,erp_verification_status,erp_verification_note,provider_application_status,provider_application_id,wechat_sub_mchid,wechat_appid,provider_status_note,updated_at",
      )
      .in("id", subjectIds);
    if (error) throw new Error(error.message);
    subjects = (data ?? []) as unknown as SubjectRow[];
  }
  const profileByLocation = new Map(profileRows.map((profile) => [profile.location_id, profile]));
  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
  return ((locations ?? []) as LocationRow[]).map((location): StorePaymentOverview => {
    const profile = profileByLocation.get(location.id) ?? null;
    const subject = profile?.subject_id ? (subjectById.get(profile.subject_id) ?? null) : null;
    return {
      location,
      profile,
      subject,
      ready_for_payment: Boolean(
        profile?.is_enabled &&
        profile.status === "active" &&
        subject?.erp_verification_status === "approved" &&
        subject.provider_application_status === "active" &&
        subject.wechat_sub_mchid &&
        subject.wechat_appid,
      ),
    };
  });
}

export const listStorePaymentsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPaymentAdmin(context);
    return listStorePaymentOverview();
  });

export const saveStorePaymentProfileFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SubjectInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertPaymentAdmin(context);
    const { data: location, error: locationError } = await supabaseAdmin
      .from("inv_locations")
      .select("id,kind,is_active")
      .eq("id", data.location_id)
      .maybeSingle();
    if (locationError) throw new Error(locationError.message);
    if (!location || location.kind !== "shop" || !location.is_active) {
      throw new Response("只能为启用中的 ERP 门店配置支付", { status: 422 });
    }

    const { data: existingProfile, error: profileError } = await supabaseAdmin
      .from("store_payment_profiles" as never)
      .select("id,subject_id")
      .eq("location_id", data.location_id)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);

    const subjectValues = {
      subject_type: data.subject_type,
      legal_name: data.legal_name,
      unified_social_credit_code: data.unified_social_credit_code.toUpperCase(),
      legal_representative_name: data.legal_representative_name,
      contact_name: data.contact_name,
      contact_phone: data.contact_phone,
      business_license_storage_path: data.business_license_storage_path ?? null,
      erp_verification_status: "draft",
      erp_verification_note: null,
      verified_by: null,
      verified_at: null,
      provider_application_status: "not_applied",
      provider_application_id: null,
      wechat_sub_mchid: null,
      wechat_appid: null,
      provider_status_note: null,
    };

    if (
      existingProfile &&
      (existingProfile as unknown as { subject_id: string | null }).subject_id
    ) {
      const existing = existingProfile as unknown as { id: string; subject_id: string };
      const { error } = await supabaseAdmin
        .from("payment_subjects" as never)
        .update(subjectValues as never)
        .eq("id", existing.subject_id);
      if (error) throw new Error(error.message);
      const { error: profileUpdateError } = await supabaseAdmin
        .from("store_payment_profiles" as never)
        .update({ status: "setup_required" } as never)
        .eq("id", existing.id);
      if (profileUpdateError) throw new Error(profileUpdateError.message);
      return { ok: true, subject_id: existing.subject_id, reset_verification: true };
    }

    const { data: subject, error: subjectError } = await supabaseAdmin
      .from("payment_subjects" as never)
      .insert({ ...subjectValues, created_by: context.userId } as never)
      .select("id")
      .single();
    if (subjectError) throw new Error(subjectError.message);
    const subjectId = (subject as unknown as { id: string }).id;
    const { error: insertProfileError } = existingProfile
      ? await supabaseAdmin
          .from("store_payment_profiles" as never)
          .update({
            subject_id: subjectId,
            status: "setup_required",
            created_by: context.userId,
          } as never)
          .eq("id", (existingProfile as unknown as { id: string }).id)
      : await supabaseAdmin.from("store_payment_profiles" as never).insert({
          location_id: data.location_id,
          subject_id: subjectId,
          created_by: context.userId,
        } as never);
    if (insertProfileError) {
      await supabaseAdmin
        .from("payment_subjects" as never)
        .delete()
        .eq("id", subjectId);
      throw new Error(insertProfileError.message);
    }
    return { ok: true, subject_id: subjectId, reset_verification: false };
  });

export const submitStorePaymentSubjectFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SubjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertPaymentAdmin(context);
    const { data: subject, error } = await supabaseAdmin
      .from("payment_subjects" as never)
      .select(
        "id,subject_type,legal_name,unified_social_credit_code,legal_representative_name,contact_name,contact_phone,business_license_storage_path",
      )
      .eq("id", data.subject_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!subject) throw new Response("支付主体不存在", { status: 404 });
    const now = new Date().toISOString();
    const { error: applicationError } = await supabaseAdmin
      .from("payment_subject_applications" as never)
      .insert({
        subject_id: data.subject_id,
        provider: "wechat",
        status: "submitted",
        application_snapshot: subject,
        submitted_by: context.userId,
        submitted_at: now,
      } as never);
    if (applicationError) throw new Error(applicationError.message);
    const { error: updateError } = await supabaseAdmin
      .from("payment_subjects" as never)
      .update({ erp_verification_status: "pending", erp_verification_note: null } as never)
      .eq("id", data.subject_id);
    if (updateError) throw new Error(updateError.message);
    const { error: profileUpdateError } = await supabaseAdmin
      .from("store_payment_profiles" as never)
      .update({ status: "pending" } as never)
      .eq("subject_id", data.subject_id);
    if (profileUpdateError) throw new Error(profileUpdateError.message);
    return { ok: true };
  });

export const reviewStorePaymentSubjectFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ReviewInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertPaymentAdmin(context);
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("payment_subjects" as never)
      .update({
        erp_verification_status: data.decision,
        erp_verification_note: data.note ?? null,
        verified_by: data.decision === "approved" ? context.userId : null,
        verified_at: data.decision === "approved" ? now : null,
      } as never)
      .eq("id", data.subject_id);
    if (error) throw new Error(error.message);
    const applicationStatus = data.decision === "approved" ? "approved" : "rejected";
    const { data: latest } = await supabaseAdmin
      .from("payment_subject_applications" as never)
      .select("id")
      .eq("subject_id", data.subject_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) {
      const { error: applicationUpdateError } = await supabaseAdmin
        .from("payment_subject_applications" as never)
        .update({
          status: applicationStatus,
          note: data.note ?? null,
          reviewed_by: context.userId,
          reviewed_at: now,
        } as never)
        .eq("id", (latest as unknown as { id: string }).id);
      if (applicationUpdateError) throw new Error(applicationUpdateError.message);
    }
    const { error: profileUpdateError } = await supabaseAdmin
      .from("store_payment_profiles" as never)
      .update({ status: data.decision === "approved" ? "pending" : "setup_required" } as never)
      .eq("subject_id", data.subject_id);
    if (profileUpdateError) throw new Error(profileUpdateError.message);
    return { ok: true };
  });

export const updateWechatPaymentStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProviderInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertPaymentAdmin(context);
    const { data: subject, error: subjectError } = await supabaseAdmin
      .from("payment_subjects" as never)
      .select("erp_verification_status")
      .eq("id", data.subject_id)
      .maybeSingle();
    if (subjectError) throw new Error(subjectError.message);
    if (!subject) throw new Response("支付主体不存在", { status: 404 });
    if (data.status === "active") {
      if (
        (subject as unknown as { erp_verification_status: string }).erp_verification_status !==
        "approved"
      ) {
        throw new Response("请先完成 ERP 主体认证", { status: 409 });
      }
      if (!data.wechat_sub_mchid || !data.wechat_appid) {
        throw new Response("微信审核通过后必须填写子商户号和 AppID", { status: 422 });
      }
    }
    const { error } = await supabaseAdmin
      .from("payment_subjects" as never)
      .update({
        provider_application_status: data.status,
        provider_application_id: data.provider_application_id ?? null,
        wechat_sub_mchid: data.wechat_sub_mchid ?? null,
        wechat_appid: data.wechat_appid ?? null,
        provider_status_note: data.note ?? null,
      } as never)
      .eq("id", data.subject_id);
    if (error) throw new Error(error.message);
    const profileStatus =
      data.status === "active" ? "active" : data.status === "suspended" ? "disabled" : "pending";
    const { data: latestApplication, error: latestApplicationError } = await supabaseAdmin
      .from("payment_subject_applications" as never)
      .select("id")
      .eq("subject_id", data.subject_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestApplicationError) throw new Error(latestApplicationError.message);
    if (latestApplication) {
      const applicationStatus =
        data.status === "active"
          ? "approved"
          : data.status === "applying"
            ? "reviewing"
            : data.status === "not_applied"
              ? "draft"
              : data.status;
      const { error: applicationUpdateError } = await supabaseAdmin
        .from("payment_subject_applications" as never)
        .update({
          status: applicationStatus,
          provider_application_id: data.provider_application_id ?? null,
          note: data.note ?? null,
          reviewed_by:
            data.status === "active" || data.status === "rejected" ? context.userId : null,
          reviewed_at:
            data.status === "active" || data.status === "rejected"
              ? new Date().toISOString()
              : null,
        } as never)
        .eq("id", (latestApplication as unknown as { id: string }).id);
      if (applicationUpdateError) throw new Error(applicationUpdateError.message);
    }
    const { error: profileUpdateError } = await supabaseAdmin
      .from("store_payment_profiles" as never)
      .update({ status: profileStatus } as never)
      .eq("subject_id", data.subject_id);
    if (profileUpdateError) throw new Error(profileUpdateError.message);
    return { ok: true };
  });
