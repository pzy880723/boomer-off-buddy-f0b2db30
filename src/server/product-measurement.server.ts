/**
 * 商品实测尺寸：顾客申请 → 门店待办 → 实测保存 → 通知申请者 → 尺寸素材版本化。
 *
 * 铁律：
 * - 尺寸只来自人工实测；AI attributes.dimensions 永远不得写入 inv_skus.measurement_*。
 * - 尺寸素材（透明抠图/比例）按 measurement_revision 归属，旧版本 job 上报一律拒绝。
 * - 抠图或几何信息不齐时素材只能是 pending/failed，不得伪造 ready。
 */

export type MeasurementInput = {
  height_cm?: number | null;
  width_cm?: number | null;
  depth_cm?: number | null;
  diameter_cm?: number | null;
};

export type MeasurementValues = {
  height_cm: number | null;
  width_cm: number | null;
  depth_cm: number | null;
  diameter_cm: number | null;
};

const MAX_CM = 9999.99;

export function validateMeasurementInput(
  input: MeasurementInput,
): { ok: true; value: MeasurementValues } | { ok: false; error: string } {
  const value: MeasurementValues = { height_cm: null, width_cm: null, depth_cm: null, diameter_cm: null };
  for (const key of ["height_cm", "width_cm", "depth_cm", "diameter_cm"] as const) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_CM) {
      return { ok: false, error: `invalid_${key}` };
    }
    value[key] = Math.round(raw * 100) / 100;
  }
  return { ok: true, value };
}

export function hasAnyMeasurement(v: MeasurementValues): boolean {
  return v.height_cm != null || v.width_cm != null || v.depth_cm != null || v.diameter_cm != null;
}

// ---------- 存储抽象（生产实现见 product-measurement-production.server.ts） ----------

/** inv_skus 无门店字段：门店归属只看 inv_stocks（见 measurementLocationAccess） */
export type MeasurementSkuRow = {
  id: string;
  measurement_revision: number;
  measured_at: string | null;
  measured_by?: string | null;
};

export type MeasurementListingRow = {
  id: string;
  sku_id: string;
  location_id: string | null;
  status: string;
  published_at: string | null;
};

export type MeasurementTaskRow = {
  id: string;
  sku_id: string;
  listing_id: string | null;
  location_id: string | null;
  status: "pending" | "claimed" | "completed" | "cancelled";
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
};

export type MeasurementAssetRow = {
  sku_id: string;
  revision: number;
  status: "pending" | "ready" | "failed";
  cutout_preview_path: string | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  front_width_px: number | null;
  front_height_px: number | null;
  px_per_cm: number | null;
  error: string | null;
};

export type MeasurementStore = {
  skus: Map<string, MeasurementSkuRow>;
  listings: Map<string, MeasurementListingRow>;
  tasks: Map<string, MeasurementTaskRow>;
  /** taskId → Set<customerId> */
  requesters: Map<string, Set<string>>;
  assets: Map<string, MeasurementAssetRow>;
  notifications: Array<{ customer_id: string; kind: string; title: string; body: string; dedupe_key: string }>;
  /** 找某商品当前活跃（pending/claimed）任务 */
  findActiveTask(skuId: string): MeasurementTaskRow | null;
  createTask(row: Omit<MeasurementTaskRow, "id" | "created_at">): MeasurementTaskRow;
  addRequester(taskId: string, customerId: string): void;
  updateTask(taskId: string, patch: Partial<MeasurementTaskRow>): void;
  saveSkuMeasurement(skuId: string, v: MeasurementValues, measuredBy: string, expectedRevision?: number): number;
  upsertAsset(row: MeasurementAssetRow): void;
  getAsset(skuId: string, revision: number): MeasurementAssetRow | null;
  notify(row: { customer_id: string; kind: string; title: string; body: string; dedupe_key: string }): void;
};

let seq = 0;
const nextId = () => `id-${++seq}`;

export function createMemoryMeasurementStore(): MeasurementStore {
  const store: MeasurementStore = {
    skus: new Map(),
    listings: new Map(),
    tasks: new Map(),
    requesters: new Map(),
    assets: new Map(),
    notifications: [],
    findActiveTask: (skuId) =>
      [...store.tasks.values()].find(
        (t) => t.sku_id === skuId && (t.status === "pending" || t.status === "claimed"),
      ) ?? null,
    createTask: (row) => {
      const task: MeasurementTaskRow = { ...row, id: nextId(), created_at: new Date().toISOString() };
      store.tasks.set(task.id, task);
      return task;
    },
    addRequester: (taskId, customerId) => {
      const set = store.requesters.get(taskId) ?? new Set<string>();
      set.add(customerId);
      store.requesters.set(taskId, set);
    },
    updateTask: (taskId, patch) => {
      const t = store.tasks.get(taskId);
      if (t) store.tasks.set(taskId, { ...t, ...patch });
    },
    saveSkuMeasurement: (skuId, v, measuredBy, expectedRevision) => {
      const sku = store.skus.get(skuId);
      if (!sku) throw new Error("not_found");
      if (expectedRevision != null && sku.measurement_revision !== expectedRevision) {
        throw new Error("revision_conflict");
      }
      const revision = sku.measurement_revision + 1;
      store.skus.set(skuId, {
        ...sku,
        ...Object.fromEntries(
          Object.entries(v).map(([k, val]) => [`measurement_${k}`, val]),
        ),
        measured_by: measuredBy,
        measured_at: new Date().toISOString(),
        measurement_revision: revision,
      });
      return revision;
    },
    upsertAsset: (row) => store.assets.set(`${row.sku_id}:${row.revision}`, row),
    getAsset: (skuId, revision) => store.assets.get(`${skuId}:${revision}`) ?? null,
    notify: (row) => {
      store.notifications.push(row);
    },
  };
  return store;
}

// ---------- 顾客申请 ----------

const REQUEST_READABLE_STATUSES = new Set(["published", "reserved", "sold", "archived"]);

export async function requestMeasurement(
  store: MeasurementStore,
  args: { customerId: string; listingId: string },
): Promise<{ status: "pending" | "completed"; task_id: string | null }> {
  const listing = store.listings.get(args.listingId);
  if (!listing || !REQUEST_READABLE_STATUSES.has(listing.status) || !listing.published_at) {
    throw new Error("not_found");
  }
  const sku = store.skus.get(listing.sku_id);
  if (!sku) throw new Error("not_found");
  // 已有实测：直接完成，不建任务（售罄商品同样如实回答，不改库存）
  if (sku.measured_at) return { status: "completed", task_id: null };

  let task = store.findActiveTask(sku.id);
  if (!task) {
    task = store.createTask({
      sku_id: sku.id,
      listing_id: listing.id,
      location_id: listing.location_id,
      status: "pending",
      claimed_by: null,
      claimed_at: null,
      completed_at: null,
      completed_by: null,
    });
  }
  store.addRequester(task.id, args.customerId);
  return { status: "pending", task_id: task.id };
}

// ---------- ERP 待办 ----------

export type MeasurementActor = {
  userId: string;
  roles: string[];
  locationIds: string[];
};

export type StockRow = { location_id: string; qty: number };

/**
 * 员工对「SKU × 门店」的权限：员工 scope（HQ 全通）+ 该店 inv_stocks 实际行。
 * edit = 该店正库存（可测量/保存/上传）；read = 该店有历史零库存行（只读已有尺寸）；none = 拒绝。
 * HQ 也不得绕过无实物校验。
 */
export function measurementLocationAccess(
  actor: MeasurementActor,
  stocks: StockRow[],
  locationId: string | null,
): "edit" | "read" | "none" {
  if (!locationId || !actorCanAccessLocation(actor, locationId)) return "none";
  const row = stocks.find((r) => r.location_id === locationId);
  if (!row) return "none";
  return row.qty > 0 ? "edit" : "read";
}

/** ERP 网页：可读 = HQ 或任一有权限门店存在库存行 */
export function actorCanReadSkuMeasurement(actor: MeasurementActor, stocks: StockRow[]): boolean {
  if (actor.roles.includes("super_admin") || actor.roles.includes("hq_operator")) return true;
  return stocks.some((r) => actor.locationIds.includes(r.location_id));
}

/**
 * ERP 网页保存门店：指定则须为 edit；未指定时仅当员工可编辑的正库存门店恰好一个才自动选，
 * 多店有货不随机选（返回 ambiguous），无货返回 no_stock。
 */
export function resolveEditableLocation(
  actor: MeasurementActor,
  stocks: StockRow[],
  requested: string | null,
): { ok: true; locationId: string } | { ok: false; error: "no_stock" | "ambiguous" | "forbidden" } {
  if (requested) {
    const access = measurementLocationAccess(actor, stocks, requested);
    if (access === "edit") return { ok: true, locationId: requested };
    return { ok: false, error: access === "none" && !actorCanAccessLocation(actor, requested) ? "forbidden" : "no_stock" };
  }
  const editable = stocks.filter((r) => r.qty > 0 && actorCanAccessLocation(actor, r.location_id));
  if (editable.length === 1) return { ok: true, locationId: editable[0].location_id };
  return { ok: false, error: editable.length === 0 ? "no_stock" : "ambiguous" };
}

export function actorCanAccessLocation(actor: MeasurementActor, locationId: string | null): boolean {
  if (actor.roles.includes("super_admin") || actor.roles.includes("hq_operator")) return true;
  return locationId != null && actor.locationIds.includes(locationId);
}

export async function claimMeasurementTask(
  store: MeasurementStore,
  args: { taskId: string; actor: MeasurementActor },
): Promise<MeasurementTaskRow> {
  const task = store.tasks.get(args.taskId);
  if (!task || task.status === "completed" || task.status === "cancelled") throw new Error("not_found");
  if (!actorCanAccessLocation(args.actor, task.location_id)) throw new Error("forbidden");
  if (task.status === "claimed" && task.claimed_by && task.claimed_by !== args.actor.userId) {
    throw new Error("already_claimed");
  }
  store.updateTask(task.id, {
    status: "claimed",
    claimed_by: args.actor.userId,
    claimed_at: new Date().toISOString(),
  });
  return store.tasks.get(task.id)!;
}

export async function completeMeasurement(
  store: MeasurementStore,
  args: {
    taskId?: string;
    skuId?: string;
    actor: MeasurementActor;
    input: MeasurementInput;
    expectedRevision?: number;
    locationId?: string | null;
  },
): Promise<{ revision: number; task_id: string | null }> {
  const parsed = validateMeasurementInput(args.input);
  if (!parsed.ok) throw new Error(parsed.error);
  if (!hasAnyMeasurement(parsed.value)) throw new Error("empty_measurement");

  const task = args.taskId ? store.tasks.get(args.taskId) : null;
  if (args.taskId && (!task || task.status === "completed" || task.status === "cancelled")) {
    throw new Error("not_found");
  }
  const skuId = task?.sku_id ?? args.skuId;
  if (!skuId) throw new Error("not_found");
  const sku = store.skus.get(skuId);
  if (!sku) throw new Error("not_found");

  const locationId = task?.location_id ?? args.locationId ?? null;
  if (!actorCanAccessLocation(args.actor, locationId)) throw new Error("forbidden");

  const revision = store.saveSkuMeasurement(skuId, parsed.value, args.actor.userId, args.expectedRevision);

  if (task) {
    store.updateTask(task.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: args.actor.userId,
    });
    for (const customerId of store.requesters.get(task.id) ?? []) {
      store.notify({
        customer_id: customerId,
        kind: "measurement_completed",
        title: "商品尺寸已测量",
        body: "您申请测量的商品尺寸已更新，打开商品详情即可查看。",
        dedupe_key: `measurement:${task.id}`,
      });
    }
  }
  return { revision, task_id: task?.id ?? null };
}

// ---------- 尺寸素材（版本化） ----------

export async function saveMeasurementDiagram(
  store: MeasurementStore,
  args: {
    skuId: string;
    revision: number;
    status: "ready" | "failed";
    cutoutPreviewPath?: string | null;
    bbox?: { x: number; y: number; w: number; h: number } | null;
    frontWidthPx?: number | null;
    frontHeightPx?: number | null;
    pxPerCm?: number | null;
    error?: string | null;
  },
): Promise<MeasurementAssetRow> {
  const sku = store.skus.get(args.skuId);
  if (!sku) throw new Error("not_found");
  if (args.revision !== sku.measurement_revision) throw new Error("stale_revision");

  const cutout = args.cutoutPreviewPath ?? null;
  const bbox = args.bbox ?? null;
  const fw = args.frontWidthPx ?? null;
  const fh = args.frontHeightPx ?? null;
  const scale = args.pxPerCm ?? null;

  if (args.status === "ready") {
    const geometryOk =
      cutout && bbox && fw && fh && scale && fw > 0 && fh > 0 && scale > 0 && bbox.w > 0 && bbox.h > 0;
    if (!geometryOk) throw new Error("incomplete_asset");
  }

  const row: MeasurementAssetRow = {
    sku_id: args.skuId,
    revision: args.revision,
    status: args.status,
    cutout_preview_path: args.status === "ready" ? cutout : null,
    bbox: args.status === "ready" ? bbox : null,
    front_width_px: args.status === "ready" ? fw : null,
    front_height_px: args.status === "ready" ? fh : null,
    px_per_cm: args.status === "ready" ? scale : null,
    error: args.status === "failed" ? (args.error ?? "unknown") : null,
  };
  store.upsertAsset(row);
  return row;
}

/** 商品详情 measurement 字段：尺寸文字与素材状态分离，素材未就绪不伪造。 */
export function buildMeasurementPayload(
  sku: MeasurementSkuRow & {
    measurement_height_cm?: number | null;
    measurement_width_cm?: number | null;
    measurement_depth_cm?: number | null;
    measurement_diameter_cm?: number | null;
  },
  asset: MeasurementAssetRow | null,
) {
  if (!sku.measured_at) return null;
  const diagram =
    asset && asset.status === "ready"
      ? {
          status: "ready" as const,
          cutout_preview_path: asset.cutout_preview_path,
          bbox: asset.bbox,
          front_width_px: asset.front_width_px,
          front_height_px: asset.front_height_px,
          px_per_cm: asset.px_per_cm,
        }
      : { status: (asset?.status ?? "pending") as "pending" | "failed" | "ready" };
  return {
    height_cm: sku.measurement_height_cm ?? null,
    width_cm: sku.measurement_width_cm ?? null,
    depth_cm: sku.measurement_depth_cm ?? null,
    diameter_cm: sku.measurement_diameter_cm ?? null,
    measured_at: sku.measured_at,
    revision: sku.measurement_revision,
    diagram,
  };
}
