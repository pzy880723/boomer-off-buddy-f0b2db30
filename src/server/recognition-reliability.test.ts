// Regression tests for the recognition reliability fix (2026-10-22 incident):
// bounded one-extra-attempt retry on timeout/transient errors, immediate failure on
// permanent 4xx / revoked consent, and structured redacted failure logging.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { allowHandheldGuard } from "./ai-guard-fixtures.ts";
import {
  recognizeProductTitle,
  PRODUCT_TITLE_MAX_ATTEMPTS,
  PRODUCT_TITLE_TIMEOUT_MS,
} from "./product-title.server";
import {
  runProductRecognition,
  isRetryableRecognitionError,
  isPermanentRecognitionError,
  extractRecognitionHttpStatus,
  RECOGNITION_FAILED_WARNING,
  type ProductRecognitionAuditInput,
  type ProductRecognitionDeps,
} from "./product-recognition.server";
import type { CategoryNode } from "../lib/product-classification";
import type { AiOutboundGuard } from "./ai-guard.ts";

const categories: CategoryNode[] = [
  { id: "root-t", code: "toy_model", name: "玩具模型", parent_id: null, is_active: true },
  { id: "toy-figure", code: "toy_character_figure", name: "角色人偶/软胶", parent_id: "root-t", is_active: true },
  { id: "root-pending", code: "classification_pending", name: "待归类", parent_id: null, is_active: true },
  { id: "pending-low", code: "ai_low_confidence", name: "AI低置信度", parent_id: "root-pending", is_active: true },
];

function depsFor(
  modelCall: ProductRecognitionDeps["callModel"],
  audits: ProductRecognitionAuditInput[],
): ProductRecognitionDeps {
  return {
    loadCategories: async () => categories,
    callModel: modelCall,
    saveAudit: async (input) => {
      audits.push(input);
      return { id: `audit-${audits.length}` };
    },
    sleep: async () => {},
  };
}

const denyingGuard: AiOutboundGuard = {
  kind: "handheld_staff",
  async check() {
    throw new Error("consent revoked");
  },
};

function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line?: unknown) => {
    lines.push(String(line));
  };
  return {
    lines,
    restore: () => {
      console.warn = original;
    },
  };
}

describe("quick title retry policy", () => {
  test("retries once after a timeout and then succeeds", async () => {
    let attempts = 0;
    const name = await recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("The operation timed out", "TimeoutError");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"蓝色复古随身听"}' } }] }));
    }, "test-key");
    assert.equal(name, "蓝色复古随身听");
    assert.equal(attempts, 2);
  });

  test("retries once on a transient network error and then succeeds", async () => {
    let attempts = 0;
    const name = await recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"美乐蒂粉色抽拉包"}' } }] }));
    }, "test-key");
    assert.equal(name, "美乐蒂粉色抽拉包");
    assert.equal(attempts, 2);
  });

  for (const status of [408, 429, 500, 503]) {
    test(`retries once on transient HTTP ${status}`, async () => {
      let attempts = 0;
      const name = await recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
        attempts += 1;
        if (attempts === 1) return new Response("busy", { status });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"复古随身听"}' } }] }));
      }, "test-key");
      assert.equal(name, "复古随身听");
      assert.equal(attempts, 2);
    });
  }

  for (const status of [400, 401, 402, 403, 404, 422]) {
    test(`does not retry permanent HTTP ${status}`, async () => {
      let attempts = 0;
      await assert.rejects(
        recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
          attempts += 1;
          return new Response("denied", { status });
        }, "test-key"),
      );
      assert.equal(attempts, 1);
    });
  }

  test("gives up after two bounded timeouts", async () => {
    let attempts = 0;
    await assert.rejects(
      recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
        attempts += 1;
        throw new DOMException("The operation timed out", "TimeoutError");
      }, "test-key"),
    );
    assert.equal(attempts, PRODUCT_TITLE_MAX_ATTEMPTS);
    assert.equal(PRODUCT_TITLE_MAX_ATTEMPTS, 2);
    assert.equal(PRODUCT_TITLE_TIMEOUT_MS, 12_000);
  });

  test("an empty or whitespace title is rejected without a retry", async () => {
    let attempts = 0;
    await assert.rejects(
      recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
        attempts += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"   "}' } }] }));
      }, "test-key"),
    );
    assert.equal(attempts, 1);
  });

  test("an unparseable title payload is rejected without a retry", async () => {
    let attempts = 0;
    await assert.rejects(
      recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
        attempts += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }));
      }, "test-key"),
    );
    assert.equal(attempts, 1);
  });

  test("never sends when consent is revoked", async () => {
    let sent = 0;
    await assert.rejects(
      recognizeProductTitle("YWJj", denyingGuard, async () => {
        sent += 1;
        return new Response("{}");
      }, "test-key"),
      /consent/,
    );
    assert.equal(sent, 0);
  });

  test("re-checks consent before the retry: revocation between attempts stops the second send", async () => {
    let sent = 0;
    let checks = 0;
    const revokingGuard: AiOutboundGuard = {
      kind: "handheld_staff",
      async check() {
        checks += 1;
        if (checks > 1) throw new Error("consent revoked");
      },
    };
    await assert.rejects(
      recognizeProductTitle("YWJj", revokingGuard, async () => {
        sent += 1;
        throw new DOMException("The operation timed out", "TimeoutError");
      }, "test-key"),
      /consent/,
    );
    assert.equal(sent, 1);
  });

  test("failure logging is structured, redacted and carries a request id", async () => {
    const { lines, restore } = captureWarn();
    try {
      await assert.rejects(
        recognizeProductTitle("YWJj", allowHandheldGuard, async () => new Response("denied", { status: 403 }), "test-key"),
      );
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.event, "product_title");
      assert.equal(entry.outcome, "failed");
      assert.equal(entry.http_status, 403);
      assert.equal(entry.attempts, 1);
      assert.equal(typeof entry.duration_ms, "number");
      assert.ok(entry.request_id);
      assert.ok(!lines.join("\n").includes("test-key"));
      assert.ok(!lines.join("\n").includes("Bearer"));
      assert.ok(!lines.join("\n").includes("YWJj"));
    } finally {
      restore();
    }
  });
});

describe("handheld recognition retry policy", () => {
  test("retries once after a timeout and then completes", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    let attempts = 0;
    const result = await runProductRecognition(
      { aiGuard: allowHandheldGuard, images: ["front"], source: "handheld" },
      depsFor(async () => {
        attempts += 1;
        if (attempts === 1) throw new DOMException("recognition timed out", "TimeoutError");
        return { model: "test-vision", raw: { category_code: "toy_character_figure", confidence: 0.9, name: "软胶怪兽" } };
      }, audits),
    );
    assert.equal(attempts, 2);
    assert.equal(result.recognition_failed, false);
    assert.equal(result.category_code, "toy_character_figure");
    assert.equal(audits[0].status, "completed");
  });

  for (const status of [400, 401, 402, 403, 404, 422]) {
    test(`fails immediately on permanent HTTP ${status}`, async () => {
      const audits: ProductRecognitionAuditInput[] = [];
      let attempts = 0;
      const result = await runProductRecognition(
        { aiGuard: allowHandheldGuard, images: ["front"], source: "handheld" },
        depsFor(async () => {
          attempts += 1;
          throw Object.assign(new Error(`AI gateway ${status}: denied`), { status });
        }, audits),
      );
      assert.equal(attempts, 1);
      assert.equal(result.recognition_failed, true);
      assert.equal(audits[0].status, "failed");
    });
  }

  test("degrades bounded after two timeouts with the fixed warning", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    let attempts = 0;
    const result = await runProductRecognition(
      { aiGuard: allowHandheldGuard, images: ["front"], source: "handheld" },
      depsFor(async () => {
        attempts += 1;
        throw new DOMException("recognition timed out", "TimeoutError");
      }, audits),
    );
    assert.equal(attempts, 2);
    assert.equal(result.recognition_failed, true);
    assert.equal(result.warning, RECOGNITION_FAILED_WARNING);
    assert.equal(audits[0].status, "failed");
    assert.deepEqual(audits[0].raw_result, { error: "recognition timed out" });
  });

  test("a low-confidence success is not reported as an AI failure", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    const result = await runProductRecognition(
      { aiGuard: allowHandheldGuard, images: ["front"], source: "handheld" },
      depsFor(async () => ({
        model: "test-vision",
        raw: { category_code: "ai_low_confidence", confidence: 0.2, name: "看不清的杂货", warning: "置信度低，需人工核对" },
      }), audits),
    );
    assert.equal(result.recognition_failed, false);
    assert.equal(result.status, "fallback");
    assert.equal(audits[0].status, "fallback");
  });

  test("never calls the model when consent is revoked and saves no audit", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    let calls = 0;
    await assert.rejects(
      runProductRecognition(
        { aiGuard: denyingGuard, images: ["front"], source: "handheld" },
        depsFor(async () => {
          calls += 1;
          throw new Error("unreachable");
        }, audits),
      ),
      /consent/,
    );
    assert.equal(calls, 0);
    assert.equal(audits.length, 0);
  });

  test("failure logging is structured, redacted and correlated with the audit id", async () => {
    const { lines, restore } = captureWarn();
    try {
      const audits: ProductRecognitionAuditInput[] = [];
      await runProductRecognition(
        { aiGuard: allowHandheldGuard, images: ["data:image/jpeg;base64,SECRETIMAGEDATA"], source: "handheld" },
        depsFor(async () => {
          throw Object.assign(new Error("AI gateway 503: upstream raw body must never be logged"), { status: 503 });
        }, audits),
      );
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.event, "product_recognition");
      assert.equal(entry.request_id, "audit-1");
      assert.equal(entry.source, "handheld");
      assert.equal(entry.attempts, 2);
      assert.equal(entry.outcome, "failed");
      assert.equal(entry.http_status, 503);
      assert.equal(typeof entry.duration_ms, "number");
      const joined = lines.join("\n");
      assert.ok(!joined.includes("upstream raw body"));
      assert.ok(!joined.includes("SECRETIMAGEDATA"));
      assert.ok(!joined.includes("Bearer"));
    } finally {
      restore();
    }
  });

  test("consent revocation logging is structured and redacted", async () => {
    const { lines, restore } = captureWarn();
    try {
      await assert.rejects(
        runProductRecognition(
          { aiGuard: denyingGuard, images: ["front"], source: "handheld" },
          depsFor(async () => {
            throw new Error("unreachable");
          }, []),
        ),
        /consent/,
      );
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.event, "product_recognition");
      assert.equal(entry.outcome, "aborted");
      assert.equal(entry.error_kind, "consent");
      assert.ok(entry.request_id);
    } finally {
      restore();
    }
  });
});

describe("retry error classification", () => {
  test("timeout, network and 408/429/5xx are retryable", () => {
    assert.equal(isRetryableRecognitionError(new DOMException("t", "TimeoutError")), true);
    assert.equal(isRetryableRecognitionError(Object.assign(new Error("x"), { name: "AbortError" })), true);
    assert.equal(isRetryableRecognitionError(new TypeError("fetch failed")), true);
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableRecognitionError(Object.assign(new Error(`AI gateway ${status}`), { status })), true);
    }
  });

  test("permanent 4xx, parse failures and transport config errors are not retryable", () => {
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      assert.equal(isRetryableRecognitionError(Object.assign(new Error(`AI gateway ${status}`), { status })), false);
      assert.equal(isPermanentRecognitionError(Object.assign(new Error(`AI gateway ${status}`), { status })), true);
    }
    assert.equal(isPermanentRecognitionError(Object.assign(new Error("permanent: relay auth unavailable"), { name: "ListingAiTransportConfigError" })), true);
    assert.equal(isRetryableRecognitionError(Object.assign(new Error("AI title missing"), { noRetry: true })), false);
  });

  test("http status is extracted from the property first, then the message", () => {
    assert.equal(extractRecognitionHttpStatus(Object.assign(new Error("boom"), { status: 503 })), 503);
    assert.equal(extractRecognitionHttpStatus(new Error("AI gateway 429: slow down")), 429);
    assert.equal(extractRecognitionHttpStatus(new Error("fetch failed")), null);
  });
});
