import React from "react";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesDashboard } from "./sales-dashboard";
import type { DashboardDisplay } from "../../lib/dashboard-view";

const data: DashboardDisplay = {
  scopeLabel: "测试门店",
  fetchedAt: "2026-09-08T01:00:00Z",
  isHq: false,
  metrics: { netSalesFen: null, grossPaidFen: 1290, orders: 1, units: null, aovFen: null },
  channels: [{ key: "youzan", label: "有赞", netSalesFen: null, grossPaidFen: 1290 }],
  trend: [{ date: "2026-09-08", netSalesFen: null, grossPaidFen: 1290 }],
  tasks: [{ key: "support", label: "未回复消息", count: null, href: "/customer-service" }],
  warnings: ["有赞退款数据尚未接入"],
};
const props = {
  loading: false,
  refreshing: false,
  range: { start: "2026-09-08", end: "2026-09-08" },
  period: "today" as const,
  onRange() {},
  locations: [{ id: "a", name: "测试门店" }],
  isHq: false,
  locationId: "a",
  onLocation() {},
  onRefresh() {},
};

test("partial data explicitly distinguishes gross from net and unknown counts", () => {
  const html = renderToStaticMarkup(<SalesDashboard {...props} data={data} />);
  assert.match(html, /待核对/);
  assert.match(html, /未扣全量退款/);
  assert.match(html, /¥12.90/);
  assert.doesNotMatch(html, /全部门店与总部/);
  assert.doesNotMatch(html, /href="\/purchase\/japan-parcel"/);
});
test("error is not rendered as zero sales or a permanent skeleton", () => {
  const html = renderToStaticMarkup(<SalesDashboard {...props} error="请求失败" />);
  assert.match(html, /加载失败/);
  assert.match(html, /不代表没有销售/);
  assert.doesNotMatch(html, /¥0.00/);
  assert.doesNotMatch(html, /正在加载经营数据/);
});
test("HQ has explicit global scope and business actions", () => {
  const html = renderToStaticMarkup(
    <SalesDashboard {...props} isHq data={{ ...data, isHq: true }} />,
  );
  assert.match(html, /全部门店与总部/);
  assert.match(html, /门店收银/);
  assert.match(html, /href="\/purchase\/japan-parcel"/);
  assert.match(html, /读取时间不等于外部渠道同步完成时间/);
});
