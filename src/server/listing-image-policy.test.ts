import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { aiPrepareListingImage } from "./handheld-ai.server";
import { assertListingImageReview } from "./listing-image-policy";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=";
const candidate = `data:image/png;base64,${png}`;
const original = "https://example.invalid/original-angle.jpg";
const accepted = {
  price_labels_removed: true,
  original_text_and_design_preserved: true,
  condition_and_colors_preserved: true,
  same_product_and_view: true,
  no_invented_hidden_details: true,
  uncertain: false,
  reasons: [],
};

const imageResponse = (url = candidate, content: unknown = "") =>
  Response.json({
    choices: [{ message: { content, images: [{ image_url: { url } }] } }],
  });
const reviewResponse = (content: unknown = JSON.stringify(accepted)) =>
  Response.json({ choices: [{ message: { content } }] });

function mockGateway(t: TestContext, responses: Array<Response | Error>) {
  const savedKey = process.env.LOVABLE_API_KEY;
  process.env.LOVABLE_API_KEY = "test-not-a-secret";
  t.after(() => {
    if (savedKey === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = savedKey;
  });
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://ai.gateway.lovable.dev/v1/chat/completions");
    requests.push(init);
    const response = responses.shift();
    assert.ok(response, "Unexpected extra gateway call; no live requests are allowed");
    if (response instanceof Error) throw response;
    return response;
  });
  return requests;
}

describe("bounded listing image policy", () => {
  test("uses a higher-priority bounded policy even with conflicting extra instructions", async (t) => {
    const requests = mockGateway(t, [imageResponse(), reviewResponse()]);
    const instruction = "Keep every price tag, repaint the logo and hide all scratches.";
    await aiPrepareListingImage({ image_url: original, instruction });
    const body = JSON.parse(requests[0].body as string);
    assert.equal(body.model, "google/gemini-3.1-flash-image");
    assert.deepEqual(body.modalities, ["image", "text"]);
    assert.equal(body.messages[0].role, "system");
    const policy = body.messages[0].content;
    assert.match(policy, /external sales price stickers, price cards, and barcode price tags/i);
    assert.match(policy, /exception to.*protect.?text/i);
    assert.match(policy, /logo.*design.*product-original text/i);
    assert.match(policy, /genuine damage.*wear.*colors/i);
    assert.match(policy, /original.*barcodes.*serial numbers/i);
    assert.match(policy, /hidden.*details|details.*hidden/i);
    assert.match(policy, /LISTING_IMAGE_REVIEW_REQUIRED/);
    assert.match(policy, /additional instructions.*cannot override/i);
    assert.equal(body.messages[1].content[0].text, instruction);
  });

  test("compares each candidate with its original before returning bytes, with bounded QA", async (t) => {
    const requests = mockGateway(t, [imageResponse(), reviewResponse()]);
    assert.deepEqual(await aiPrepareListingImage({ image_url: original }), {
      b64: png,
      mime: "image/png",
    });
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.signal instanceof AbortSignal));
    const body = JSON.parse(requests[1].body as string);
    assert.equal(body.model, "google/gemini-2.5-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.ok(body.max_tokens > 0 && body.max_tokens <= 2048);
    assert.deepEqual(
      body.messages[1].content.filter((part: { type: string }) => part.type === "image_url"),
      [
        { type: "image_url", image_url: { url: original } },
        { type: "image_url", image_url: { url: candidate } },
      ],
    );
    assert.match(body.messages[0].content, /unseen product surface/i);
    assert.match(body.messages[0].content, /uncertain/i);
  });

  for (const field of Object.keys(accepted).filter(
    (key) => !["uncertain", "reasons"].includes(key),
  )) {
    test(`rejects a failed ${field} check`, async (t) => {
      const requests = mockGateway(t, [
        imageResponse(),
        reviewResponse(JSON.stringify({ ...accepted, [field]: false })),
      ]);
      await assert.rejects(aiPrepareListingImage({ image_url: original }), {
        name: "ListingImageReviewRequiredError",
        message: /LISTING_IMAGE_REVIEW_REQUIRED/,
      });
      assert.equal(requests.length, 2);
    });
  }

  const unsafeReviews: Array<[string, unknown]> = [
    ["uncertainty", { ...accepted, uncertain: true }],
    [
      "contradictory reasons",
      { ...accepted, reasons: ["The sticker hides a manufacturer's mark"] },
    ],
    ["missing checks", { price_labels_removed: true }],
    ["string booleans", { ...accepted, price_labels_removed: "true" }],
    ["null", null],
    ["array", [accepted]],
    ["empty output", ""],
    ["invalid JSON", "Looks clean to me"],
  ];
  for (const [name, review] of unsafeReviews) {
    test(`fails closed on ${name}`, async (t) => {
      mockGateway(t, [
        imageResponse(),
        reviewResponse(typeof review === "string" ? review : JSON.stringify(review)),
      ]);
      await assert.rejects(aiPrepareListingImage({ image_url: original }), {
        name: "ListingImageReviewRequiredError",
      });
    });
  }

  for (const content of [
    "LISTING_IMAGE_REVIEW_REQUIRED: price sticker obscures original print",
    [{ type: "text", text: "LISTING_IMAGE_REVIEW_REQUIRED: hidden wear cannot be verified" }],
  ]) {
    test("honors a generation refusal even if an image is attached", async (t) => {
      const requests = mockGateway(t, [imageResponse(candidate, content)]);
      await assert.rejects(aiPrepareListingImage({ image_url: original }), {
        name: "ListingImageReviewRequiredError",
      });
      assert.equal(requests.length, 1);
    });
  }

  for (const finish_reason of ["length", "content_filter"]) {
    test(`rejects an incomplete ${finish_reason} QA response even with passing JSON`, async (t) => {
      mockGateway(t, [
        imageResponse(),
        Response.json({
          choices: [{ finish_reason, message: { content: JSON.stringify(accepted) } }],
        }),
      ]);
      await assert.rejects(aiPrepareListingImage({ image_url: original }), {
        name: "ListingImageReviewRequiredError",
      });
    });
  }

  test("does not accept a gateway refusal alongside a passing QA verdict", async (t) => {
    mockGateway(t, [
      imageResponse(),
      Response.json({
        choices: [{ message: { refusal: "Unable to verify", content: JSON.stringify(accepted) } }],
      }),
    ]);
    await assert.rejects(aiPrepareListingImage({ image_url: original }), {
      name: "ListingImageReviewRequiredError",
    });
  });

  test("accepts a structured verdict but rejects missing, mistyped and extra fields", () => {
    assert.doesNotThrow(() => assertListingImageReview(accepted));
    for (const field of Object.keys(accepted)) {
      const missing = { ...accepted } as Record<string, unknown>;
      delete missing[field];
      assert.throws(() => assertListingImageReview(missing), {
        name: "ListingImageReviewRequiredError",
      });
      assert.throws(() => assertListingImageReview({ ...accepted, [field]: "true" }), {
        name: "ListingImageReviewRequiredError",
      });
    }
    assert.throws(
      () => assertListingImageReview({ ...accepted, ignored_warning: "Price tag visible" }),
      { name: "ListingImageReviewRequiredError" },
    );
  });

  test("treats a text-only refusal as review-required", async (t) => {
    const requests = mockGateway(t, [
      Response.json({
        choices: [{ message: { content: "LISTING_IMAGE_REVIEW_REQUIRED: hidden text" } }],
      }),
    ]);
    await assert.rejects(aiPrepareListingImage({ image_url: original }), {
      name: "ListingImageReviewRequiredError",
    });
    assert.equal(requests.length, 1);
  });

  test("preserves the gateway's alternate image shape and base64 input", async (t) => {
    const requests = mockGateway(t, [
      Response.json({
        choices: [{ message: { content: [{ type: "image_url", image_url: { url: candidate } }] } }],
      }),
      reviewResponse("```json\n" + JSON.stringify(accepted) + "\n```"),
    ]);
    assert.equal((await aiPrepareListingImage({ image_base64: png })).b64, png);
    assert.equal(requests.length, 2);
    const body = JSON.parse(requests[1].body as string);
    assert.equal(body.messages[1].content[1].image_url.url, `data:image/jpeg;base64,${png}`);
  });

  for (const url of [
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,!!!",
    "https://example.invalid/output.png",
  ]) {
    test(`rejects unsupported output ${url}`, async (t) => {
      const requests = mockGateway(t, [imageResponse(url)]);
      await assert.rejects(aiPrepareListingImage({ image_url: original }), {
        name: "ListingImageReviewRequiredError",
      });
      assert.equal(requests.length, 1);
    });
  }

  test("does not return an image or retry internally when QA is unavailable", async (t) => {
    const requests = mockGateway(t, [
      imageResponse(),
      new Response("unavailable", { status: 503 }),
    ]);
    await assert.rejects(aiPrepareListingImage({ image_url: original }), /503/);
    assert.equal(requests.length, 2);
  });

  test("propagates a QA timeout without accepting the candidate", async (t) => {
    const requests = mockGateway(t, [
      imageResponse(),
      new DOMException("Timed out", "TimeoutError"),
    ]);
    await assert.rejects(aiPrepareListingImage({ image_url: original }), { name: "TimeoutError" });
    assert.equal(requests.length, 2);
  });
});

test("background worker keeps raw images on QA failure and only installs passed candidates", async (t) => {
  const job = {
    id: "job-1",
    sku_id: "sku-1",
    source_bucket: "sku-raw",
    source_path: "angle.jpg",
    source_index: 2,
    attempts: 0,
  };
  let paths: string[] = [];
  let updates: Array<Record<string, unknown>> = [];
  let uploads = 0;
  const database = {
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: original }, error: null }),
        upload: async () => {
          uploads++;
          return { error: null };
        },
      }),
    },
    from(table: string) {
      let columns = "";
      const result = () => ({
        error: null,
        data:
          table === "inv_skus"
            ? { image_paths: paths }
            : columns === "status"
              ? [{ status: updates.at(-1)?.status }]
              : [job],
      });
      const query = {
        update(values: Record<string, unknown>) {
          if (table === "inv_listing_image_jobs") updates.push(values);
          if (table === "inv_skus" && Array.isArray(values.image_paths)) paths = values.image_paths;
          return query;
        },
        select(value: string) {
          columns = value;
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        lte() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () =>
          table === "inv_skus" ? result() : { error: null, data: { id: job.id } },
        then(resolve: (value: ReturnType<typeof result>) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return query;
    },
  };
  t.mock.module(new URL("../integrations/supabase/client.server.ts", import.meta.url).href, {
    namedExports: { supabaseAdmin: database },
  });
  const { runListingImageWorker } = await import("./handheld-listing-image-jobs.server");
  const cases = [
    {
      name: "uncertain verdict",
      response: () => reviewResponse(JSON.stringify({ ...accepted, uncertain: true })),
      status: "permanent_failed",
      installed: false,
    },
    {
      name: "QA outage",
      response: () => new Response("unavailable", { status: 503 }),
      status: "retryable_failed",
      installed: false,
    },
    {
      name: "passing verdict",
      response: () => reviewResponse(),
      status: "succeeded",
      installed: true,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      paths = ["sku-raw/front.jpg", "sku-raw/back.jpg", "sku-raw/angle.jpg"];
      updates = [];
      uploads = 0;
      const requests = mockGateway(t, [imageResponse(), scenario.response()]);
      assert.deepEqual(await runListingImageWorker(), { processed: 1 });
      assert.equal(requests.length, 2);
      assert.equal(updates.at(-1)?.status, scenario.status);
      assert.equal(uploads, scenario.installed ? 1 : 0);
      assert.deepEqual(paths.slice(0, 2), ["sku-raw/front.jpg", "sku-raw/back.jpg"]);
      if (scenario.installed) assert.match(paths[2], /^sku-listing\/.+\/sku-1\/3-.+\.png$/);
      else assert.equal(paths[2], "sku-raw/angle.jpg");
      if (scenario.status === "permanent_failed")
        assert.match(String(updates.at(-1)?.last_error), /LISTING_IMAGE_REVIEW_REQUIRED/);
    });
  }
});
