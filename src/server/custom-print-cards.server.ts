/**
 * 门店自定义打印卡片核心（依赖注入，纯业务；路由与 worker 注入真实数据库/AI）。
 * - 店员仅能读写当前授权库位的 custom 卡；HQ 走现有库位授权，不额外获得发布权。
 * - 只有 super_admin 能把 ready 卡原子转为全门店 preset，以及修改/删除 preset。
 * - 所有版本变更走 expected_version CAS；创建按 (created_by, client_op_id) 幂等。
 * - AI 文案仅可写参考信息能证明的内容；品牌/年份/材质/稀缺性无依据即拦截。
 */
import { z } from "zod";

export type CardFormat = "portrait" | "landscape";
export type CardContent = { title: string; headline: string; body: string };
export type CardRow = {
  id: string;
  location_id: string;
  topic: string;
  instructions: string;
  formats: CardFormat[];
  reference_image_path: string | null;
  reference_device_id: string | null;
  content: CardContent | null;
  state: "custom" | "preset";
  status: "queued" | "processing" | "ready" | "failed";
  error: string | null;
  version: number;
  client_op_id: string;
  created_by: string;
  job_token?: string | null;
  created_at: string;
  updated_at: string;
};
export type Card = Pick<CardRow, "id" | "location_id" | "topic" | "instructions" | "formats" | "reference_image_path" | "content" | "state" | "status" | "error" | "version" | "created_at" | "updated_at">;
export type Actor = { userId: string; deviceId: string };
type NewRow = Pick<CardRow, "location_id" | "topic" | "instructions" | "formats" | "reference_image_path" | "reference_device_id" | "client_op_id" | "created_by">;
type Patch = Partial<Pick<CardRow, "topic" | "instructions" | "formats" | "reference_image_path" | "reference_device_id" | "content" | "state" | "status" | "error">> & { published_by?: string; job_token?: null; attempts?: number };

export type CustomCardDeps = {
  roles(userId: string): Promise<string[]>;
  canAccess(userId: string, locationId: string): Promise<boolean>;
  list(q: { state: "custom" | "preset"; location_id: string }): Promise<CardRow[]>;
  get(id: string): Promise<CardRow | null>;
  insertIdempotent(row: NewRow): Promise<{ card: CardRow; created: boolean }>;
  /** 单条 UPDATE ... WHERE id AND version [AND state]；版本 +1；未命中返回 null。 */
  updateCas(id: string, expectedVersion: number, patch: Patch, requireState?: "custom" | "preset"): Promise<CardRow | null>;
  deleteCas(id: string, expectedVersion: number): Promise<boolean>;
  claim(limit: number): Promise<CardRow[]>;
  finish(id: string, jobToken: string, claimedVersion: number, patch: Patch): Promise<boolean>;
  loadReference(path: string): Promise<{ mime: string; b64: string }>;
  /** 对象存在且为受支持图片（按内容识别 MIME）。 */
  verifyReference(path: string): Promise<boolean>;
  generate(input: { topic: string; instructions: string; formats: CardFormat[]; image: { mime: string; b64: string } | null }): Promise<unknown>;
};

export const LIMITS = { title: 18, headline: 20, body: 90 } as const;
const len = (s: string) => Array.from(s).length;
const uuid = z.string().uuid();
const formats = z.array(z.enum(["portrait", "landscape"])).min(1).max(2).refine((a) => new Set(a).size === a.length, "duplicate_format");
const field = (max: number, code: string) => z.string().transform((v) => v.trim())
  .refine((v) => v.length > 0, `${code}_empty`).refine((v) => len(v) <= max, `${code}_too_long`);
/** 可打印内容：三个字段 trim 后均非空且不超长。 */
const contentSchema = z.object({
  title: field(18, "title"), headline: field(20, "headline"), body: field(90, "body"),
}).strict();
const topic = z.string().trim().min(1).max(120);
const instructions = z.string().max(500);
const version = z.number().int().min(1);

export const CreateBody = z.object({
  location_id: uuid, client_op_id: uuid, topic, instructions: instructions.default(""), formats,
  reference_image_path: z.string().max(300).optional(),
}).strict();
export const PatchBody = z.object({
  location_id: uuid, expected_version: version, topic: topic.optional(), instructions: instructions.optional(),
  formats: formats.optional(), reference_image_path: z.string().max(300).nullable().optional(),
  content: contentSchema.optional(), regenerate: z.boolean().optional(),
}).strict().refine((v) => !(v.content && v.regenerate), "content_and_regenerate");
export const VersionBody = z.object({ location_id: uuid, expected_version: version }).strict();

type Res<T> = { status: 200 | 202; body: T } | { status: number; code: string };
const fail = (status: number, code: string) => ({ status, code });

/** 只接受本设备经 /items/upload-image 写入 sku-raw 的路径：YYYY-MM-DD/{deviceId}/{uuid}.ext */
export function isOwnedReferencePath(path: string, deviceId: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.(jpe?g|png|webp|heic)$/i.exec(path);
  return !!m && m[2].toLowerCase() === deviceId.toLowerCase();
}

export function toCard(r: CardRow): Card {
  return {
    id: r.id, location_id: r.location_id, topic: r.topic, instructions: r.instructions, formats: r.formats,
    reference_image_path: r.reference_image_path, content: r.content, state: r.state, status: r.status,
    error: r.error, version: r.version, created_at: r.created_at, updated_at: r.updated_at,
  };
}

const isAdmin = async (d: CustomCardDeps, u: string) => (await d.roles(u)).includes("super_admin");

/** 读取并校验卡片可见性：custom 必须属于该库位；preset 对任意授权库位可读。 */
async function load(d: CustomCardDeps, a: Actor, id: string, locationId: string) {
  if (!uuid.safeParse(id).success || !uuid.safeParse(locationId).success) return fail(422, "validation_error");
  if (!(await d.canAccess(a.userId, locationId))) return fail(403, "location_forbidden");
  const row = await d.get(id);
  if (!row || (row.state === "custom" && row.location_id !== locationId)) return fail(404, "not_found");
  return row;
}

export async function listCards(d: CustomCardDeps, a: Actor, q: { location_id?: string | null; state?: string | null }): Promise<Res<{ cards: Card[]; can_publish: boolean }>> {
  const p = z.object({ location_id: uuid, state: z.enum(["custom", "preset"]).default("custom") }).safeParse({ location_id: q.location_id, state: q.state ?? undefined });
  if (!p.success) return fail(422, "validation_error");
  if (!(await d.canAccess(a.userId, p.data.location_id))) return fail(403, "location_forbidden");
  const [rows, admin] = await Promise.all([d.list(p.data), isAdmin(d, a.userId)]);
  return { status: 200, body: { cards: rows.map(toCard), can_publish: admin } };
}

export async function createCard(d: CustomCardDeps, a: Actor, raw: unknown): Promise<Res<Card>> {
  const p = CreateBody.safeParse(raw);
  if (!p.success) return fail(422, "validation_error");
  const b = p.data;
  if (!(await d.canAccess(a.userId, b.location_id))) return fail(403, "location_forbidden");
  if (b.reference_image_path && !isOwnedReferencePath(b.reference_image_path, a.deviceId)) return fail(403, "reference_forbidden");
  if (b.reference_image_path && !(await d.verifyReference(b.reference_image_path))) return fail(422, "reference_invalid");
  const row: NewRow = {
    location_id: b.location_id, topic: b.topic, instructions: b.instructions, formats: b.formats,
    reference_image_path: b.reference_image_path ?? null, reference_device_id: b.reference_image_path ? a.deviceId : null,
    client_op_id: b.client_op_id, created_by: a.userId,
  };
  const { card, created } = await d.insertIdempotent(row);
  if (!created) {
    const same = card.location_id === row.location_id && card.topic === row.topic && card.instructions === row.instructions &&
      card.formats.join() === row.formats.join() && card.reference_image_path === row.reference_image_path;
    if (!same) return fail(409, "client_op_conflict");
  }
  return { status: 202, body: toCard(card) };
}

export async function getCard(d: CustomCardDeps, a: Actor, id: string, locationId: string): Promise<Res<Card>> {
  const r = await load(d, a, id, locationId);
  return "code" in r ? r : { status: 200, body: toCard(r) };
}

export async function patchCard(d: CustomCardDeps, a: Actor, id: string, raw: unknown): Promise<Res<Card>> {
  const p = PatchBody.safeParse(raw);
  if (!p.success) return fail(422, "validation_error");
  const b = p.data;
  const r = await load(d, a, id, b.location_id);
  if ("code" in r) return r;
  if (r.state === "preset" && !(await isAdmin(d, a.userId))) return fail(403, "admin_only");
  if (r.version !== b.expected_version) return fail(409, "version_conflict");
  const patch: Patch = {};
  if (b.topic !== undefined) patch.topic = b.topic;
  if (b.instructions !== undefined) patch.instructions = b.instructions;
  if (b.formats !== undefined) patch.formats = b.formats;
  if (b.reference_image_path !== undefined) {
    if (b.reference_image_path === null) { patch.reference_image_path = null; patch.reference_device_id = null; }
    else if (b.reference_image_path !== r.reference_image_path) {
      if (!isOwnedReferencePath(b.reference_image_path, a.deviceId)) return fail(403, "reference_forbidden");
      if (!(await d.verifyReference(b.reference_image_path))) return fail(422, "reference_invalid");
      patch.reference_image_path = b.reference_image_path; patch.reference_device_id = a.deviceId;
    }
  }
  if (b.content) { patch.content = b.content; patch.status = "ready"; patch.error = null; patch.job_token = null; }
  else if (b.regenerate) { patch.status = "queued"; patch.error = null; patch.job_token = null; patch.attempts = 0; }
  else if (r.status === "queued" || r.status === "processing") { patch.status = "queued"; patch.job_token = null; }
  const next = await d.updateCas(id, b.expected_version, patch, r.state);
  return next ? { status: 200, body: toCard(next) } : fail(409, "version_conflict");
}

export async function deleteCard(d: CustomCardDeps, a: Actor, id: string, raw: unknown): Promise<Res<{ deleted: true }>> {
  const p = VersionBody.safeParse(raw);
  if (!p.success) return fail(422, "validation_error");
  const r = await load(d, a, id, p.data.location_id);
  if ("code" in r) return r;
  if (r.state === "preset" && !(await isAdmin(d, a.userId))) return fail(403, "admin_only");
  if (r.version !== p.data.expected_version) return fail(409, "version_conflict");
  // 只删卡片记录；参考图属于上传对象，不删除任何商品原图。
  return (await d.deleteCas(id, p.data.expected_version)) ? { status: 200, body: { deleted: true } } : fail(409, "version_conflict");
}

export async function publishCard(d: CustomCardDeps, a: Actor, id: string, raw: unknown): Promise<Res<Card>> {
  const p = VersionBody.safeParse(raw);
  if (!p.success) return fail(422, "validation_error");
  const r = await load(d, a, id, p.data.location_id);
  if ("code" in r) return r;
  if (!(await isAdmin(d, a.userId))) return fail(403, "admin_only");
  if (r.state === "preset") return { status: 200, body: toCard(r) }; // 重复发布幂等
  if (r.version !== p.data.expected_version) return fail(409, "version_conflict");
  if (r.status !== "ready" || !r.content) return fail(409, "not_ready");
  const next = await d.updateCas(id, p.data.expected_version, { state: "preset", published_by: a.userId }, "custom");
  if (next) return { status: 200, body: toCard(next) };
  const now = await d.get(id);
  return now?.state === "preset" ? { status: 200, body: toCard(now) } : fail(409, "version_conflict");
}

// ---------- AI 文案生成与防编造 ----------
const CLAIMS: RegExp[] = [
  /(1[89]\d{2}|20\d{2})\s*年?代?/g, /\d{2}年代/g, /昭和|平成|大正|明治/g,
  /限量|稀有|稀缺|绝版|孤品|珍稀|罕见|收藏级|唯一|仅此一[件只个]/g,
  /正品|官方|原厂|联名|授权/g,
  /纯棉|全棉|羊毛|羊绒|真皮|牛皮|羊皮|丝绸|真丝|纯银|925|黄金|K金|实木|陶瓷|骨瓷|纯铜|不锈钢|亚麻|麻料|皮革/g,
  /[A-Za-z][A-Za-z0-9&'.-]{2,}/g, // 拉丁字母品牌/型号
];
export function unsupportedClaims(c: CardContent, source: string): string[] {
  const src = source.toLowerCase();
  const text = `${c.title}\n${c.headline}\n${c.body}`;
  const out = new Set<string>();
  for (const re of CLAIMS) for (const m of text.matchAll(re)) if (!src.includes(m[0].toLowerCase())) out.add(m[0]);
  return [...out];
}

export const SAFE_ERRORS = {
  reference: "参考照片无法读取，请重新上传或移除后重新生成",
  claims: "生成的文案含有参考信息无法证明的内容（品牌/年份/材质/稀缺性等），已拦截，请补充说明后重新生成",
  format: "AI 返回的文案格式无效，请重新生成",
  busy: "AI 文案服务繁忙，请稍后重新生成",
  quota: "AI 文案服务额度不足，请联系总部",
  unavailable: "AI 文案服务暂时不可用，请稍后重新生成",
} as const;

function safeGenerationError(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/\b429\b/.test(m)) return SAFE_ERRORS.busy;
  if (/\b402\b/.test(m)) return SAFE_ERRORS.quota;
  return SAFE_ERRORS.unavailable;
}

function clampContent(raw: unknown): CardContent | null {
  const p = contentSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export async function processCustomCardJobs(d: CustomCardDeps, limit: number) {
  // 每次只领取 1 张并立即处理：尚未执行的卡不会提前占用租约而过期被重复领取。
  const max = Math.max(1, Math.min(limit, 6));
  let claimed = 0, ready = 0, failed = 0, stale = 0;
  for (let i = 0; i < max; i++) {
    const [job] = await d.claim(1);
    if (!job) break;
    claimed++;
    let patch: Patch;
    try {
      let image: { mime: string; b64: string } | null = null;
      if (job.reference_image_path) {
        try { image = await d.loadReference(job.reference_image_path); }
        catch { throw Object.assign(new Error("ref"), { safe: SAFE_ERRORS.reference }); }
      }
      let raw: unknown;
      try { raw = await d.generate({ topic: job.topic, instructions: job.instructions, formats: job.formats, image }); }
      catch (e) { throw Object.assign(new Error("gen"), { safe: safeGenerationError(e) }); }
      const content = clampContent(raw);
      if (!content) throw Object.assign(new Error("fmt"), { safe: SAFE_ERRORS.format });
      if (unsupportedClaims(content, `${job.topic}\n${job.instructions}`).length) throw Object.assign(new Error("claims"), { safe: SAFE_ERRORS.claims });
      patch = { status: "ready", content, error: null };
    } catch (e) {
      patch = { status: "failed", error: (e as { safe?: string }).safe ?? SAFE_ERRORS.unavailable };
    }
    const ok = await d.finish(job.id, job.job_token!, job.version, patch);
    if (!ok) stale++;
    else if (patch.status === "ready") ready++;
    else failed++;
  }
  return { claimed, ready, failed, stale };
}

export const GENERATION_PROMPT =
  "你为二手中古杂货店写打印卡片短文案。只能使用【主题】【补充说明】和参考照片中肉眼可直接确认的内容。" +
  "禁止编造：品牌、型号、年份/年代、产地、材质成分、真伪/授权、限量/稀有/孤品等稀缺性，除非这些词已出现在主题或补充说明中。" +
  `输出：title 不超过${LIMITS.title}字（商品/主题名），headline 不超过${LIMITS.headline}字（一句吸引人但有依据的短句），body 不超过${LIMITS.body}字（简短介绍外观、用途、氛围）。` +
  "全部中文，不要价格、不要表情符号、不要英文。" +
  "若附有参考照片：照片只用于描述可见的外观、颜色、图案和用途；不得根据画面风格、磨损或印刷推测年份/年代、品牌、产地、材质或稀缺性。";
