import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  CATEGORY_GROUP_SYNC_CONFIRM,
  assertCategoryGroupSyncHost,
  buildGroupCreateParams,
  buildGroupRelationQueryParams,
  buildGroupRelationUpdateParams,
  buildGroupSearchParams,
  buildHqItemSearchParams,
  buildProductGroupAssignments,
  parseCategoryGroupSyncRequest,
  selectProductLinksForCategories,
  selectPublicCategoryTree,
  selectUniqueHqItem,
} from "./youzan-category-groups.ts";

const categories = [
  { id: "root-a", code: "toy_model", name: "玩具模型", parent_id: null, sort_order: 30, is_active: true, kind: "category" },
  { id: "leaf-a", code: "toy_plush", name: "毛绒玩具", parent_id: "root-a", sort_order: 31, is_active: true, kind: "category" },
  { id: "root-b", code: "daily_misc", name: "日用杂货", parent_id: null, sort_order: 130, is_active: true, kind: "category" },
  { id: "pending", code: "classification_pending", name: "待归类", parent_id: null, sort_order: 9990, is_active: true, kind: "category" },
  { id: "pending-leaf", code: "ai_low_confidence", name: "AI低置信度", parent_id: "pending", sort_order: 9991, is_active: true, kind: "category" },
  { id: "disabled", code: "disabled", name: "停用分类", parent_id: null, sort_order: 40, is_active: false, kind: "category" },
];

test("ERP public category tree excludes workflow and disabled categories", () => {
  const selected = selectPublicCategoryTree(categories);
  assert.deepEqual(selected.map((category) => category.code), ["toy_model", "daily_misc", "toy_plush"]);
  assert.deepEqual(selected.map((category) => category.depth), [0, 0, 1]);
});

test("category code filter keeps the selected root and descendants", () => {
  const selected = selectPublicCategoryTree(categories, ["toy_model"]);
  assert.deepEqual(selected.map((category) => category.code), ["toy_model", "toy_plush"]);
});

test("Youzan group APIs use the documented request wrapper", () => {
  assert.deepEqual(buildGroupSearchParams(153242272, 1, 2).request, {
    kdt_id: 153242272,
    channel: 1,
    page_no: 2,
  });
  assert.deepEqual(buildGroupCreateParams({ kdtId: 153242272, channel: 1, title: "毛绒玩具", parentGroupId: 99 }).request, {
    kdt_id: 153242272,
    channel: 1,
    title: "毛绒玩具",
    parent_group_id: 99,
  });
});

test("group relation update overwrites at most ten products per call", () => {
  const params = buildGroupRelationUpdateParams({
    kdtId: 153242272,
    channel: 1,
    itemIds: Array.from({ length: 12 }, (_, index) => index + 1),
    groupIds: [88],
  });
  assert.equal(params.kdt_id, "153242272");
  assert.deepEqual(params.item_ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(params.group_ids, [88]);
  assert.equal(params.operate_type, 3);
  assert.equal(params.channel, 1);

  const query = buildGroupRelationQueryParams(153242272, 1, 1).request;
  assert.deepEqual(query, { kdt_id: 153242272, channel: 1, item_id: 1 });
});

test("HQ product search uses the documented base-search filters", () => {
  assert.deepEqual(
    buildHqItemSearchParams({
      kdtId: 153242272,
      channel: 1,
      itemCode: "SKU-TY-260524-QUXU",
    }),
    {
      kdt_id: 153242272,
      channel: 1,
      is_displays: [0, 1],
      page_no: 1,
      page_size: 50,
      item_codes: ["SKU-TY-260524-QUXU"],
    },
  );
});

test("HQ product matching prefers ERP item code and rejects ambiguity", () => {
  const seed = {
    category_code: "toy_model",
    stored_item_id: 5070816493,
    name: "玩具模型",
    item_codes: ["SKU-TY-260524-QUXU"],
    barcodes: ["6900000000001"],
  };
  const rows = [
    { item_id: 11, channel_item_id: 101, kdt_id: 1, root_kdt_id: 1, title: "玩具模型", item_code: "OTHER", item_barcode: "" },
    { item_id: 12, channel_item_id: 102, kdt_id: 1, root_kdt_id: 1, title: "玩具模型", item_code: "SKU-TY-260524-QUXU", item_barcode: "" },
  ];
  assert.equal(selectUniqueHqItem(rows, seed)?.item_id, 12);
  assert.throws(
    () => selectUniqueHqItem(rows.map((row) => ({ ...row, item_code: "OTHER" })), seed),
    /匹配不唯一/,
  );
});

test("product assignments deduplicate shared item IDs and skip workflow categories", () => {
  const tree = selectPublicCategoryTree(categories);
  const assignments = buildProductGroupAssignments({
    categories: tree,
    productLinks: [
      { category_code: "toy_model", item_id: 1001 },
      { category_code: "toy_model", item_id: 1001 },
      { category_code: "toy_plush", item_id: 1002 },
      { category_code: "ai_low_confidence", item_id: 1003 },
    ],
    groupIdsByCategoryCode: new Map([
      ["toy_model", 81],
      ["toy_plush", 82],
    ]),
  });
  assert.deepEqual(assignments, [
    { categoryCode: "toy_model", groupId: 81, itemIds: [1001] },
    { categoryCode: "toy_plush", groupId: 82, itemIds: [1002] },
  ]);
});

test("category canary filters product links before applying its item limit", () => {
  const tree = selectPublicCategoryTree(categories, ["toy_model"]);
  const selected = selectProductLinksForCategories({
    categories: tree,
    productLinks: [
      { category_code: "daily_misc", item_id: 2001 },
      { category_code: "toy_model", item_id: 1001 },
      { category_code: "toy_plush", item_id: 1002 },
    ],
    maxItems: 1,
  });
  assert.deepEqual(selected, [{ category_code: "toy_model", item_id: 1001 }]);
});

test("formal sync needs confirmation and Tencent production host", () => {
  assert.deepEqual(parseCategoryGroupSyncRequest({}), {
    dryRun: true,
    confirm: "",
    channels: [0, 1],
    categoryCodes: [],
    maxItems: 10000,
  });
  assert.throws(() => parseCategoryGroupSyncRequest({ dry_run: false }), new RegExp(CATEGORY_GROUP_SYNC_CONFIRM));
  assert.doesNotThrow(() => assertCategoryGroupSyncHost("lovable.app", true));
  assert.throws(() => assertCategoryGroupSyncHost("lovable.app", false), /erp\.boomeroff\.com/);
  assert.doesNotThrow(() => assertCategoryGroupSyncHost("erp.boomeroff.com", false));
});

test("migration stores group mappings separately from Youzan retail categories", () => {
  const sql = readFileSync(
    new URL(
      "../../supabase/migrations/20260822143000_youzan_category_group_sync.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /youzan_category_group_links/);
  assert.match(sql, /youzan_category_group_sync_runs/);
  assert.match(sql, /UNIQUE \(category_id, hq_shop_id, channel\)/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.inv_categories[\s\S]*youzan_hq_category_id/i);
});

test("group sync resolves HQ online item ids and never uses branch credentials", () => {
  const source = readFileSync(
    new URL("./youzan-category-groups.server.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.eq\("shop_id", hqShopId\)/);
  assert.match(source, /\.eq\("role", "hq_spu"\)/);
  assert.match(source, /\.eq\("status", "linked"\)/);
  assert.match(source, /youzan\.item\.base\.search/);
  assert.match(source, /ensureAccessToken\(hq\)/);
  assert.match(source, /buildGroupRelationQueryParams\(Number\(hq\.kdt_id\)/);
  assert.match(source, /buildGroupRelationUpdateParams\(\{[\s\S]*kdtId: Number\(hq\.kdt_id\)/);
  assert.match(source, /hq_shop_id: hq\.id/);
  assert.doesNotMatch(source, /ensureAccessToken\(shop\)/);
});
