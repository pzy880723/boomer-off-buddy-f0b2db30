import process from "node:process";

import pg from "pg";

import { transformBoomerOpenSnapshot } from "./boomer-open-transform.mjs";
import {
  readSyncState,
  snapshotDigest,
  writeSyncState,
} from "./sync-state.mjs";

const { Pool } = pg;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function dateOnly(value) {
  return value ? value.slice(0, 10) : null;
}

async function fetchSnapshot() {
  const baseUrl = required("BOOMER_OPEN_BASE_URL").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { "x-boomer-token": required("BOOMER_OPEN_APP_TOKEN") },
  });
  if (!response.ok) {
    throw new Error(`BOOMER OPEN bootstrap failed: ${response.status}`);
  }
  return response.json();
}

async function main() {
  const snapshot = await fetchSnapshot();
  const digest = snapshotDigest(snapshot);
  const stateFile = process.env.SYNC_STATE_FILE?.trim();
  const dryRun = process.env.DRY_RUN !== "false";
  if (
    !dryRun &&
    process.env.FORCE_SYNC !== "true" &&
    stateFile &&
    (await readSyncState(stateFile)) === digest
  ) {
    console.log(JSON.stringify({ mode: "no-change", digest }, null, 2));
    return;
  }

  const transformed = transformBoomerOpenSnapshot(snapshot, {
    bucket: required("BOOMER_OPEN_COS_BUCKET"),
    region: process.env.BOOMER_OPEN_COS_REGION || "ap-shanghai",
  });

  const summary = {
    projects: transformed.projects.length,
    stages: transformed.projects.reduce(
      (sum, project) => sum + project.stages.length,
      0,
    ),
    tasks: transformed.projects.reduce(
      (sum, project) =>
        sum +
        project.stages.reduce(
          (stageSum, stage) => stageSum + stage.tasks.length,
          0,
        ),
      0,
    ),
    costs: transformed.costs.length,
    attachments: transformed.attachments.length,
    contractAnalyses: transformed.attachments.filter(
      (attachment) => attachment.contractAnalysis,
    ).length,
  };

  if (dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", ...summary }, null, 2));
    return;
  }

  const pool = new Pool({
    connectionString: required("TARGET_DATABASE_URL"),
    ssl:
      process.env.TARGET_DATABASE_SSL === "false"
        ? false
        : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select set_config('app.audit_source', $1, true)", [
      "boomer-open-migration",
    ]);

    const projectIds = new Map();
    const stageIds = new Map();
    const attachmentIds = new Map();

    for (const project of transformed.projects) {
      const projectResult = await client.query(
        `insert into public.store_development_projects (
           legacy_id, name, brand, project_kind, status, address, place_name,
           latitude, longitude, progress, budget_amount, deposit_target_amount,
           handover_date, planned_opening_date, source_system,
           source_updated_at, legacy_document
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
           'boomer_open',$15,$16
         )
         on conflict (legacy_id) do update set
           name = excluded.name,
           brand = excluded.brand,
           project_kind = excluded.project_kind,
           status = excluded.status,
           address = excluded.address,
           place_name = excluded.place_name,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           progress = excluded.progress,
           budget_amount = excluded.budget_amount,
           deposit_target_amount = excluded.deposit_target_amount,
           handover_date = excluded.handover_date,
           planned_opening_date = excluded.planned_opening_date,
           source_updated_at = excluded.source_updated_at,
           legacy_document = excluded.legacy_document,
           updated_at = now()
         returning id`,
        [
          project.legacyId,
          project.name,
          project.brand,
          project.projectKind,
          project.status,
          project.address,
          project.placeName,
          project.latitude,
          project.longitude,
          project.progress,
          project.budgetAmount,
          project.depositTargetAmount,
          dateOnly(project.handoverDate),
          dateOnly(project.plannedOpeningDate),
          project.sourceUpdatedAt,
          project.legacyDocument,
        ],
      );
      const projectId = projectResult.rows[0].id;
      projectIds.set(project.legacyId, projectId);

      for (const stage of project.stages) {
        const stageResult = await client.query(
          `insert into public.store_development_stages (
             project_id, stage_key, title, subtitle, status, sort_order,
             legacy_document
           ) values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (project_id, stage_key) do update set
             title = excluded.title,
             subtitle = excluded.subtitle,
             status = excluded.status,
             sort_order = excluded.sort_order,
             legacy_document = excluded.legacy_document,
             updated_at = now()
           returning id`,
          [
            projectId,
            stage.stageKey,
            stage.title,
            stage.subtitle,
            stage.status,
            stage.sortOrder,
            stage.legacyDocument,
          ],
        );
        const stageId = stageResult.rows[0].id;
        stageIds.set(`${project.legacyId}:${stage.sortOrder}`, stageId);

        for (const task of stage.tasks) {
          await client.query(
            `insert into public.store_development_tasks (
               stage_id, task_key, title, status, sort_order, completed_at,
               legacy_document
             ) values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (stage_id, task_key) do update set
               title = excluded.title,
               status = excluded.status,
               sort_order = excluded.sort_order,
               completed_at = excluded.completed_at,
               legacy_document = excluded.legacy_document,
               updated_at = now()`,
            [
              stageId,
              task.taskKey,
              task.title,
              task.status,
              task.sortOrder,
              task.status === "completed" ? project.sourceUpdatedAt : null,
              task.legacyDocument,
            ],
          );
        }
      }
    }

    for (const attachment of transformed.attachments) {
      const projectId = projectIds.get(attachment.projectLegacyId);
      if (!projectId) {
        throw new Error(
          `Attachment ${attachment.legacyId} references an unknown project`,
        );
      }
      const stageId = stageIds.get(
        `${attachment.projectLegacyId}:${attachment.stageIndex}`,
      );
      const attachmentResult = await client.query(
        `insert into public.store_development_attachments (
           legacy_id, project_id, stage_id, kind, file_name, mime_type,
           size_bytes, storage_provider, storage_bucket, storage_region,
           storage_path, source_created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (legacy_id) do update set
           project_id = excluded.project_id,
           stage_id = excluded.stage_id,
           kind = excluded.kind,
           file_name = excluded.file_name,
           mime_type = excluded.mime_type,
           size_bytes = excluded.size_bytes,
           storage_provider = excluded.storage_provider,
           storage_bucket = excluded.storage_bucket,
           storage_region = excluded.storage_region,
           storage_path = excluded.storage_path,
           source_created_at = excluded.source_created_at,
           updated_at = now()
         returning id`,
        [
          attachment.legacyId,
          projectId,
          stageId || null,
          attachment.kind,
          attachment.fileName,
          attachment.mimeType,
          attachment.sizeBytes,
          attachment.storageProvider,
          attachment.storageBucket,
          attachment.storageRegion,
          attachment.storagePath,
          attachment.sourceCreatedAt,
        ],
      );
      const attachmentId = attachmentResult.rows[0].id;
      attachmentIds.set(attachment.legacyId, attachmentId);

      const analysis = attachment.contractAnalysis;
      if (analysis) {
        await client.query(
          `insert into public.store_development_contract_analyses (
             legacy_id, project_id, attachment_id, status, deposit_amount,
             deposit_refund_terms, deposit_refund_deadline,
             contract_start_date, contract_end_date, monthly_rent,
             rent_payment_terms, key_terms, risk_flags, summary,
             error_message, raw_document, analyzed_at
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
           )
           on conflict (attachment_id) do update set
             legacy_id = excluded.legacy_id,
             status = excluded.status,
             deposit_amount = excluded.deposit_amount,
             deposit_refund_terms = excluded.deposit_refund_terms,
             deposit_refund_deadline = excluded.deposit_refund_deadline,
             contract_start_date = excluded.contract_start_date,
             contract_end_date = excluded.contract_end_date,
             monthly_rent = excluded.monthly_rent,
             rent_payment_terms = excluded.rent_payment_terms,
             key_terms = excluded.key_terms,
             risk_flags = excluded.risk_flags,
             summary = excluded.summary,
             error_message = excluded.error_message,
             raw_document = excluded.raw_document,
             analyzed_at = excluded.analyzed_at,
             updated_at = now()`,
          [
            analysis.id || `analysis-${attachment.legacyId}`,
            projectId,
            attachmentId,
            analysis.status || "failed",
            analysis.depositAmount ?? null,
            analysis.depositRefundTerms ?? null,
            analysis.depositRefundDeadline ?? null,
            dateOnly(analysis.contractStartDate),
            dateOnly(analysis.contractEndDate),
            analysis.monthlyRent ?? null,
            analysis.rentPaymentTerms ?? null,
            analysis.keyTerms ?? [],
            analysis.riskFlags ?? [],
            analysis.summary ?? null,
            analysis.error ?? null,
            analysis,
            analysis.analyzedAt ?? null,
          ],
        );
      }
    }

    for (const cost of transformed.costs) {
      const projectId = projectIds.get(cost.projectLegacyId);
      if (!projectId) {
        throw new Error(`Cost ${cost.legacyId} references an unknown project`);
      }
      const stage = transformed.projects
        .find((project) => project.legacyId === cost.projectLegacyId)
        ?.stages.find((value) => value.title === cost.stageTitle);
      const stageId =
        stage &&
        stageIds.get(`${cost.projectLegacyId}:${stage.sortOrder}`);
      const sourceAttachmentId = cost.sourceAttachmentLegacyId
        ? attachmentIds.get(cost.sourceAttachmentLegacyId)
        : null;

      await client.query(
        `insert into public.store_development_costs (
           legacy_id, project_id, stage_id, item_name, amount, deposit_amount,
           category, vendor, invoice_status, recognition_id,
           source_attachment_id, source_created_at, legacy_document
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (legacy_id) do update set
           project_id = excluded.project_id,
           stage_id = excluded.stage_id,
           item_name = excluded.item_name,
           amount = excluded.amount,
           deposit_amount = excluded.deposit_amount,
           category = excluded.category,
           vendor = excluded.vendor,
           invoice_status = excluded.invoice_status,
           recognition_id = excluded.recognition_id,
           source_attachment_id = excluded.source_attachment_id,
           source_created_at = excluded.source_created_at,
           legacy_document = excluded.legacy_document,
           updated_at = now()`,
        [
          cost.legacyId,
          projectId,
          stageId || null,
          cost.itemName,
          cost.amount,
          Math.min(cost.depositAmount, cost.amount),
          cost.category,
          cost.vendor,
          cost.invoiceStatus,
          cost.recognitionId,
          sourceAttachmentId || null,
          cost.sourceCreatedAt,
          cost.legacyDocument,
        ],
      );
    }

    const verification = await client.query(`
      select
        (select count(*)::int from public.store_development_projects
          where source_system = 'boomer_open') as projects,
        (select count(*)::int from public.store_development_costs
          where legacy_id is not null) as costs,
        (select count(*)::int from public.store_development_attachments
          where storage_provider = 'tencent_cos') as attachments
    `);

    if (
      verification.rows[0].projects < summary.projects ||
      verification.rows[0].costs < summary.costs ||
      verification.rows[0].attachments < summary.attachments
    ) {
      throw new Error(
        `Verification failed: ${JSON.stringify(verification.rows[0])}`,
      );
    }

    await client.query("commit");
    await writeSyncState(stateFile, digest);
    console.log(
      JSON.stringify(
        {
          mode: "commit",
          digest,
          source: summary,
          target: verification.rows[0],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
