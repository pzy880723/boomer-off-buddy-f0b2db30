const statusMap = new Map([
  ["选址中", "site_selection"],
  ["合同中", "contracting"],
  ["装修中", "construction"],
  ["开业准备", "pre_opening"],
  ["验收中", "acceptance"],
  ["已开业", "opened"],
  ["已归档", "archived"],
  ["已取消", "cancelled"],
  ["跟进中", "planning"],
]);

function nullableDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stageKey(index) {
  return `legacy-stage-${index}`;
}

function taskKey(index) {
  return `legacy-task-${index}`;
}

function projectAliases(snapshot, projectIds) {
  const attachments = new Map(
    (snapshot.attachments ?? []).map((attachment) => [
      String(attachment.id),
      attachment,
    ]),
  );
  const aliases = new Map();

  for (const record of snapshot.costRecords ?? []) {
    if (!record.sourceAttachmentId || !record.projectId) continue;
    const attachment = attachments.get(String(record.sourceAttachmentId));
    if (!attachment?.projectId) continue;

    const sourceId = String(attachment.projectId);
    const targetId = String(record.projectId);
    if (sourceId === targetId || !projectIds.has(targetId)) continue;

    const existing = aliases.get(sourceId);
    if (existing && existing !== targetId) {
      throw new Error(
        `Legacy project ${sourceId} maps to both ${existing} and ${targetId}`,
      );
    }
    aliases.set(sourceId, targetId);
  }

  return aliases;
}

export function transformBoomerOpenSnapshot(snapshot, storage) {
  const projects = (snapshot.projects ?? []).map((project) => ({
    legacyId: String(project.id),
    name: String(project.name),
    brand: String(project.brand || "BOOMER OFF"),
    projectKind: project.isCandidate ? "candidate" : "formal",
    status: project.isCandidate
      ? "candidate"
      : statusMap.get(project.status) ?? "planning",
    address: project.address || null,
    placeName: project.placeName || null,
    latitude: project.latitude ?? null,
    longitude: project.longitude ?? null,
    progress: Math.min(1, Math.max(0, numeric(project.progress))),
    budgetAmount: Math.max(0, numeric(project.budget)),
    depositTargetAmount: Math.max(0, numeric(project.deposit)),
    handoverDate: nullableDate(project.handoverDate),
    plannedOpeningDate: nullableDate(project.plannedOpeningDate),
    sourceUpdatedAt: nullableDate(project.updatedAt),
    legacyDocument: project,
    stages: (project.stages ?? []).map((stage, stageIndex) => ({
      stageKey: stageKey(stageIndex),
      title: String(stage.title),
      subtitle: stage.subtitle || null,
      status: ["completed", "active", "upcoming"].includes(stage.status)
        ? stage.status
        : "upcoming",
      sortOrder: stageIndex,
      legacyDocument: stage,
      tasks: (stage.tasks ?? []).map((task, taskIndex) => ({
        taskKey: taskKey(taskIndex),
        title: String(task.title),
        status: task.completed ? "completed" : "pending",
        sortOrder: taskIndex,
        legacyDocument: task,
      })),
    })),
  }));
  const aliases = projectAliases(
    snapshot,
    new Set(projects.map((project) => project.legacyId)),
  );

  const costs = (snapshot.costRecords ?? []).map((record) => ({
    legacyId: String(record.id),
    projectLegacyId: String(record.projectId),
    itemName: String(record.itemName),
    amount: Math.max(0, numeric(record.amount)),
    depositAmount: Math.max(0, numeric(record.depositAmount)),
    category: String(record.category || "未分类"),
    stageTitle: record.stage || null,
    vendor: record.vendor || null,
    invoiceStatus: record.invoiceStatus || "unknown",
    recognitionId: record.recognitionId || null,
    sourceAttachmentLegacyId: record.sourceAttachmentId || null,
    sourceCreatedAt: nullableDate(record.createdAt),
    legacyDocument: record,
  }));

  const attachments = (snapshot.attachments ?? []).map((attachment) => ({
    legacyId: String(attachment.id),
    projectLegacyId:
      aliases.get(String(attachment.projectId)) ??
      String(attachment.projectId),
    stageIndex: numeric(attachment.stageIndex, -1),
    kind: String(attachment.kind || "unknown"),
    fileName: String(attachment.fileName || "attachment"),
    mimeType: String(attachment.mimeType || "application/octet-stream"),
    sizeBytes: Math.max(0, numeric(attachment.size)),
    storageProvider: "tencent_cos",
    storageBucket: storage.bucket,
    storageRegion: storage.region,
    storagePath: String(attachment.cloudPath),
    sourceCreatedAt: nullableDate(attachment.createdAt),
    contractAnalysis: attachment.contractAnalysis || null,
  }));

  return { projects, costs, attachments };
}
