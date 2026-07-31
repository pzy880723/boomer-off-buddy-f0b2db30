import assert from "node:assert/strict";
import test from "node:test";

import { transformBoomerOpenSnapshot } from "./boomer-open-transform.mjs";

test("normalizes BOOMER OPEN projects while preserving source documents", () => {
  const result = transformBoomerOpenSnapshot(
    {
      projects: [
        {
          id: "wenzhou-shuomen-8",
          name: "温州朔门街浙江首店",
          brand: "BOOMER OFF",
          address: "温州市",
          status: "装修中",
          progress: 0.64,
          budget: 180000,
          deposit: 30000,
          stages: [
            {
              title: "装修施工",
              subtitle: "进行中",
              status: "active",
              tasks: [
                { title: "水电施工", completed: true },
                { title: "门头安装", completed: false },
              ],
            },
          ],
        },
      ],
    },
    { bucket: "boomer-files-123", region: "ap-shanghai" },
  );

  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].status, "construction");
  assert.equal(result.projects[0].legacyId, "wenzhou-shuomen-8");
  assert.equal(result.projects[0].stages[0].stageKey, "legacy-stage-0");
  assert.equal(result.projects[0].stages[0].tasks[0].status, "completed");
  assert.equal(result.projects[0].legacyDocument.status, "装修中");
});

test("keeps COS attachments in place and maps costs idempotently", () => {
  const result = transformBoomerOpenSnapshot(
    {
      costRecords: [
        {
          id: "cost-1",
          projectId: "project-1",
          itemName: "店铺押金",
          amount: 80000,
          depositAmount: 30000,
          category: "合同",
          stage: "确定店铺与合同",
          createdAt: "2026-07-29T10:00:00Z",
        },
      ],
      attachments: [
        {
          id: "file-1",
          projectId: "project-1",
          stageIndex: 1,
          kind: "contract",
          fileName: "合同.pdf",
          mimeType: "application/pdf",
          size: 2048,
          cloudPath: "boomer-open/project-1/stage-1/file-1.pdf",
          createdAt: "2026-07-29T10:00:00Z",
        },
      ],
    },
    { bucket: "boomer-files-123", region: "ap-shanghai" },
  );

  assert.equal(result.costs[0].legacyId, "cost-1");
  assert.equal(result.costs[0].depositAmount, 30000);
  assert.equal(result.attachments[0].storageProvider, "tencent_cos");
  assert.equal(
    result.attachments[0].storagePath,
    "boomer-open/project-1/stage-1/file-1.pdf",
  );
});

test("reconciles a renamed project from its cost attachment relationship", () => {
  const result = transformBoomerOpenSnapshot(
    {
      projects: [
        {
          id: "current-project-id",
          name: "温州朔门街浙江首店",
          stages: [],
        },
      ],
      costRecords: [
        {
          id: "cost-1",
          projectId: "current-project-id",
          itemName: "珠宝柜",
          amount: 1000,
          sourceAttachmentId: "file-1",
        },
      ],
      attachments: [
        {
          id: "file-1",
          projectId: "retired-project-id",
          fileName: "quick-cost-ai-recognized.png",
          cloudPath: "boomer-open/retired-project-id/file-1.png",
        },
        {
          id: "file-2",
          projectId: "retired-project-id",
          fileName: "quick-cost-ai-recognized.png",
          cloudPath: "boomer-open/retired-project-id/file-2.png",
        },
      ],
    },
    { bucket: "boomer-files-123", region: "ap-shanghai" },
  );

  assert.deepEqual(
    result.attachments.map((attachment) => attachment.projectLegacyId),
    ["current-project-id", "current-project-id"],
  );
});
