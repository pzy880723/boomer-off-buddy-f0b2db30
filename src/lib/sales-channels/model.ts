// 多渠道销售 v1 纯逻辑（无 I/O）：渠道视图、消费端来源识别、worker 执行前复核、批量结果聚合。
// 权威校验在 DB（0117 sales_channel_apply / 订单行触发器）；这里只负责展示与预检，规则与 DB 一致。

export const SALES_CHANNELS = ["miniapp", "app", "youzan"] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];
export type ConsumerChannel = "miniapp" | "app" | "unknown";

export const CHANNEL_LABELS: Record<SalesChannel, string> = {
  miniapp: "官方小程序",
  app: "官方APP",
  youzan: "有赞门店收银",
};

export const REASON_LABELS: Record<string, string> = {
  not_in_store: "该商品不在本店库存中",
  no_store_listing: "尚未在本店建立线上商品",
  sold_locked: "商品已售出，不能重新上架",
  youzan_shop_unbound: "本店未绑定有赞门店",
  youzan_auth_expired: "有赞授权已过期，请重新授权",
  youzan_not_mapped: "本店有赞收银台尚未建立该商品",
  no_stock: "本店无库存，不能在收银台上架",
  version_conflict: "商品渠道已被他人修改，请刷新后重试",
  invalid_change: "渠道参数不正确",
};

export function reasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASON_LABELS[code] ?? code;
}

/** 只认验签后 payload.client_kind（会话级）；绑定历史（wechat_mini_*）不代表当前来源。 */
export function resolveConsumerChannel(
  identity: { clientKind?: string | null } | null | undefined,
): ConsumerChannel {
  const k = identity?.clientKind;
  return k === "miniapp" || k === "app" ? k : "unknown";
}

/** 匿名目录的 storefront_channel 仅作展示上下文，不是授权；不能用于下单。 */
export function catalogDisplayChannel(param: string | null | undefined): ConsumerChannel {
  return param === "miniapp" || param === "app" ? param : "unknown";
}

/** 与 DB sales_channel_allowed 相同：仅显式关闭才拦截；未知来源任一消费端关闭即拦截。 */
export function consumerChannelAllowed(
  disabled: ReadonlyArray<{ channel: string }>,
  channel: ConsumerChannel,
): boolean {
  const relevant = channel === "unknown" ? ["miniapp", "app"] : [channel];
  return !disabled.some((d) => relevant.includes(d.channel));
}

export type IntentFact = { channel: SalesChannel; enabled: boolean; version: number };
export type ChannelFacts = {
  stockQty: number | null; // null = 本店无库存记录
  salesState: string | null;
  listing: { status: string; readiness_hold: boolean | null } | null;
  shop: { bound: boolean; authorized: boolean };
  youzan: {
    external_item_id: string | null;
    listing_status: string | null;
    last_verified_at: string | null;
  } | null;
  youzanPending: boolean;
  intents: IntentFact[];
};

export type ChannelView = {
  channel: SalesChannel;
  label: string;
  selected: boolean;
  selection_source: "explicit" | "default";
  version: number;
  available: boolean;
  platform_status: string;
  blocked_reason: string | null;
  is_store_channel: boolean;
  verified_at: string | null;
};

/** 返回开启/关闭各自的阻断原因代码（与 DB 一致）。 */
export function channelBlocks(channel: SalesChannel, f: ChannelFacts): { enable: string | null; disable: string | null } {
  if (f.stockQty === null) return { enable: "not_in_store", disable: "not_in_store" };
  const sold = f.salesState !== "active";
  if (channel !== "youzan") {
    if (!f.listing) return { enable: "no_store_listing", disable: null };
    if (sold || ["sold", "archived"].includes(f.listing.status)) return { enable: "sold_locked", disable: null };
    return { enable: null, disable: null };
  }
  const mapping = !f.shop.bound
    ? "youzan_shop_unbound"
    : !f.shop.authorized
      ? "youzan_auth_expired"
      : !f.youzan?.external_item_id
        ? "youzan_not_mapped"
        : null;
  if (mapping) return { enable: mapping, disable: mapping };
  if (sold) return { enable: "sold_locked", disable: null };
  if (f.stockQty <= 0) return { enable: "no_stock", disable: null };
  return { enable: null, disable: null };
}

export function buildChannelView(channel: SalesChannel, f: ChannelFacts): ChannelView {
  const intent = f.intents.find((i) => i.channel === channel) ?? null;
  const selected = intent
    ? intent.enabled
    : channel === "youzan"
      ? f.youzan?.listing_status === "published"
      : true;
  const blocks = channelBlocks(channel, f);
  const block = selected ? blocks.disable : blocks.enable;
  let platform: string;
  if (channel === "youzan") {
    platform = f.youzanPending ? "syncing" : f.youzan?.listing_status ?? "not_mapped";
  } else if (!f.listing) platform = "not_listed";
  else if (f.listing.status === "sold" || f.listing.status === "archived") platform = f.listing.status;
  else if (!selected) platform = "disabled";
  else if (f.listing.status !== "published" || f.listing.readiness_hold) platform = "hidden";
  else platform = "published";
  return {
    channel,
    label: CHANNEL_LABELS[channel],
    selected,
    selection_source: intent ? "explicit" : "default",
    version: intent?.version ?? 0,
    available: block === null,
    platform_status: platform,
    blocked_reason: reasonLabel(block),
    is_store_channel: channel === "youzan",
    verified_at: channel === "youzan" ? f.youzan?.last_verified_at ?? null : null,
  };
}

export function buildChannelViews(f: ChannelFacts): ChannelView[] {
  return SALES_CHANNELS.map((c) => buildChannelView(c, f));
}

/** 批量预览：按方向检查每个变更，返回可执行变更或跳过原因。 */
export function planSkuChanges(
  f: ChannelFacts,
  add: readonly SalesChannel[],
  remove: readonly SalesChannel[],
): { changes: Record<string, { enabled: boolean; expected_version: number }>; skipReason: string | null } {
  if (f.stockQty === null) return { changes: {}, skipReason: "not_in_store" };
  const changes: Record<string, { enabled: boolean; expected_version: number }> = {};
  let firstBlock: string | null = null;
  for (const [list, enabled] of [[add, true], [remove, false]] as const) {
    for (const ch of list) {
      const b = channelBlocks(ch, f);
      const block = enabled ? b.enable : b.disable;
      if (block) { firstBlock ??= block; continue; }
      changes[ch] = { enabled, expected_version: f.intents.find((i) => i.channel === ch)?.version ?? 0 };
    }
  }
  return { changes, skipReason: Object.keys(changes).length ? null : firstBlock ?? "invalid_change" };
}

export type ApplyResult = { sku_id: string; channel: string; success: boolean; reason?: string; status?: string };

/** 每个 SKU 一条：全部渠道成功才算成功；首个失败原因中文化。 */
export function aggregateBySku(skuIds: readonly string[], results: readonly ApplyResult[]) {
  return skuIds.map((sku_id) => {
    const rows = results.filter((r) => r.sku_id === sku_id);
    const fail = rows.find((r) => !r.success);
    if (!rows.length) return { sku_id, success: false, reason: reasonLabel("invalid_change")! };
    if (fail) return { sku_id, success: false, reason: reasonLabel(fail.reason) ?? "失败" };
    const status = rows.some((r) => r.status === "queued") ? "queued" : rows.every((r) => r.status === "unchanged") ? "unchanged" : "applied";
    return { sku_id, success: true, status };
  });
}

// ---- worker 执行前复核（有赞写入前） ----
export type IntentTaskPayload = { source?: string; intent_version?: number; enabled?: boolean; location_id?: string };

export function isSalesIntentTask(task: { request_payload?: unknown }): boolean {
  return (task.request_payload as IntentTaskPayload | null)?.source === "sales_channel_intent";
}

export function evaluateSalesIntentTask(
  task: { action: string; request_payload?: unknown },
  facts: { intent: { enabled: boolean; version: number } | null; salesState: string | null; stockQty: number | null; readFailed?: boolean },
): { verdict: "proceed" | "supersede" | "block"; reason: string } {
  const p = (task.request_payload ?? {}) as IntentTaskPayload;
  if (typeof p.intent_version !== "number") return { verdict: "block", reason: "任务缺少渠道意图版本" };
  if (facts.readFailed) return { verdict: "block", reason: "渠道意图或库存读取失败" };
  if (!facts.intent || facts.intent.version !== p.intent_version) return { verdict: "supersede", reason: "已有更新的渠道设置" };
  const wantOn = task.action === "shelf";
  if (facts.intent.enabled !== wantOn) return { verdict: "supersede", reason: "渠道设置与任务方向不一致" };
  if (wantOn) {
    if (facts.salesState !== "active") return { verdict: "supersede", reason: "商品已售出，不重新上架" };
    if (facts.stockQty === null) return { verdict: "block", reason: "本店库存读取失败" };
    if (facts.stockQty <= 0) return { verdict: "supersede", reason: "本店无库存，不上架" };
  }
  return { verdict: "proceed", reason: "ok" };
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 单件请求哈希：同 op_id 必须是同一 SKU + 同一组变更。 */
export function singleRequestFingerprint(
  skuId: string,
  changes: ReadonlyArray<{ channel: string; enabled: boolean; expected_version: number }>,
): string {
  const sorted = [...changes].sort((a, b) => a.channel.localeCompare(b.channel));
  return JSON.stringify({ sku: skuId, changes: sorted.map((c) => [c.channel, c.enabled, c.expected_version]) });
}
