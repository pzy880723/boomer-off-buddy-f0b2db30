import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Manifest, Preset, permitted, packA4, resolveSelection, sameOriginUrl, channels, parseNativeManifest, assertQrLocation, matchesSpecification, type CardPreset } from './contract';
import { projectQr } from './qr-policy';
const loc = '11111111-1111-4111-8111-111111111111';
const base = (extra: Partial<CardPreset> = {}): CardPreset => ({ id: 'one', type_id: 'one', name: 'test', category: 'store_notice', enabled: true, orientation: 'landscape', width_mm: 90, height_mm: 30, image_path: '/cards/one.png', ...extra });
test('原生数组清单保留PDF和缩略图路径，提示竖版拒绝，非法路径和跨店响应拒绝', () => {
  const row = { id: 'native', title: '原版', subtitle: '', category: '店铺提示', widthMM: 90, heightMM: 30, file: 'native.pdf', thumbnail: 'native.png', pairID: null };
  const [card] = parseNativeManifest([row]);
  assert.equal(card?.image_path, '/print-presets/native.pdf');
  assert.equal(card?.thumbnail_path, '/print-presets/native.png');
  assert.equal(parseNativeManifest([{ ...row, widthMM: 80, heightMM: 120 }]).filter(permitted).length, 0);
  assert.throws(() => parseNativeManifest([{ ...row, file: '../other.pdf' }]));
  assert.throws(() => parseNativeManifest([row, row]));
  assert.throws(() => assertQrLocation(null, loc));
  assert.throws(() => assertQrLocation('other', loc));
  assertQrLocation(loc, loc);
});
test('扫码六用途和提示仅90×30，历史停用和竖牌在输出时同样拒绝', () => {
  for (const category of ['qr', 'store_notice'] as const) {
    for (const p of [base({ category, orientation: 'portrait', width_mm: 80, height_mm: 120 }), base({ category, enabled: false }), base({ category, width_mm: 91 })]) {
      assert.equal(permitted(p), false);
      assert.throws(() => resolveSelection([p], [{ id: p.id, quantity: 1 }], loc, [...channels]));
      assert.throws(() => packA4([p]));
    }
  }
  for (const channel of channels) assert.equal(permitted(base({ category: 'qr', channel, qr_box: { x_mm: 2, y_mm: 2, size_mm: 26 } })), true);
});
test('IP品牌品类进口来源保留横竖版；商品卡60×90不变', () => {
  for (const category of ['ip', 'brand', 'category', 'import_origin'] as const) {
    assert.ok(permitted(base({ category })));
    assert.ok(permitted(base({ category, orientation: 'portrait', width_mm: 80, height_mm: 120 })));
  }
  assert.ok(permitted(base({ category: 'product', orientation: 'portrait', width_mm: 60, height_mm: 90 })));
  assert.equal(permitted(base({ category: 'product' })), false);
});
test('跨店/缺码/旧id/重复/数量越界拒绝，小程序不借用别的码', () => {
  const p = base({ category: 'qr', channel: 'miniprogram', qr_box: { x_mm: 1, y_mm: 1, size_mm: 28 } });
  assert.throws(() => resolveSelection([p], [{ id: p.id, quantity: 1 }], loc, ['wechat']));
  assert.throws(() => resolveSelection([base({ location_id: '22222222-2222-4222-8222-222222222222' })], [{ id: 'one', quantity: 1 }], loc, []));
  for (const input of [[{ id: 'old', quantity: 1 }], [{ id: 'one', quantity: 0 }], [{ id: 'one', quantity: 101 }], [{ id: 'one', quantity: 1 }, { id: 'one', quantity: 1 }]]) assert.throws(() => resolveSelection([base()], input, loc, []));
});
test('清单严格校验、重复id、外域和错误二维码框拒绝', () => {
  assert.ok(Manifest.parse({ version: 1, presets: [base()] }));
  assert.throws(() => Manifest.parse({ version: 1, presets: [base(), base()] }));
  assert.throws(() => Preset.parse(base({ image_path: 'https://other.com/a.png' })));
  assert.throws(() => Preset.parse(base({ category: 'qr', channel: 'wechat', qr_box: { x_mm: 80, y_mm: 0, size_mm: 25 } })));
  for (const path of ['//other.com/a.png', '/cards/../a.png', '/cards/%2e%2e/a.png', '/a.png?token=secret', '/a.png#hash']) assert.throws(() => sameOriginUrl(path, 'https://erp.boomeroff.com'));
});
test('193预设合成拼版零间距、原尺寸、无重叠且都在A4范围内', () => {
  const cards = Array.from({ length: 193 }, (_, i) => base({ id: String(i) }));
  const pages = packA4(cards);
  assert.equal(pages.flat().length, 193);
  assert.equal(packA4(Array.from({ length: 18 }, () => base())).length, 1);
  for (const page of pages) for (const [i, a] of page.entries()) {
    assert.equal(a.width * a.height, a.preset.width_mm * a.preset.height_mm);
    assert.ok(a.x >= 5 && a.y >= 5 && a.x + a.width <= 205 && a.y + a.height <= 285);
    for (const b of page.slice(i + 1)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
});
test('混合横竖尺寸旋转不改变成品面积', () => {
  const cards = [base({ category: 'brand', width_mm: 120, height_mm: 80 }), base({ category: 'ip', orientation: 'portrait', width_mm: 80, height_mm: 120 }), base({ category: 'product', orientation: 'portrait', width_mm: 60, height_mm: 90 })];
  assert.equal(packA4(cards).flat().length, 3);
});
const hook = (extra: Partial<CardPreset> = {}) => base({ category: 'ip', width_mm: 80, height_mm: 40, ...extra });
test('实际宽高独立匹配挂钩、货架、立牌；全部保留其他既有尺寸', () => {
  const rows = [hook(), base(), base({ category: 'ip', width_mm: 80, height_mm: 120, orientation: 'portrait' }), base({ category: 'brand', width_mm: 120, height_mm: 80 }), base({ category: 'product', width_mm: 60, height_mm: 90, orientation: 'portrait' })];
  for (const [spec, index] of [['hook', 0], ['shelf', 1], ['standing', 2]] as const) assert.deepEqual(rows.filter(p => matchesSpecification(p, spec)), [rows[index]]);
  assert.deepEqual(rows.filter(p => matchesSpecification(p, 'all')), rows);
  assert.equal(matchesSpecification(hook({ orientation: 'portrait' }), 'hook'), true); // filtering uses dimensions, eligibility separately checks orientation
  assert.equal(matchesSpecification(base({ width_mm: 40, height_mm: 80 }), 'hook'), false);
  assert.equal(matchesSpecification(hook(), 'unknown'), false);
});
test('80×40仅IP品类可用，扫码提示、品牌进口来源商品和停用在输出时拒绝', () => {
  for (const category of ['ip', 'category'] as const) assert.ok(permitted(hook({ category })));
  for (const p of [hook({ enabled: false }), hook({ orientation: 'portrait' }), ...(['qr', 'store_notice', 'brand', 'import_origin', 'product'] as const).map(category => hook({ category }))]) {
    assert.equal(permitted(p), false);
    assert.throws(() => resolveSelection([p], [{ id: p.id, quantity: 1 }], loc, [...channels]));
    assert.throws(() => packA4([p]));
  }
});
test('纯80×40每页17：准确坐标、旋转、零间距、数量、边界、不重叠与尺寸', () => {
  for (const count of [0, 1, 14, 15, 17, 18, 34, 35, 88]) {
    const cards = Array.from({ length: count }, (_, i) => hook({ id: String(i), category: i % 2 ? 'category' : 'ip' }));
    const pages = packA4(cards);
    assert.equal(pages.length, Math.ceil(count / 17));
    assert.equal(pages.flat().length, count);
    assert.equal(new Set(pages.flat().map(p => p.preset.id)).size, count);
    assert.deepEqual(pages.map(p => p.length), Array.from({ length: Math.ceil(count / 17) }, (_, i) => Math.min(17, count - i * 17)));
    for (const page of pages) for (const [i, a] of page.entries()) {
      assert.deepEqual([a.x, a.y, a.width, a.height, a.rotated], i < 14 ? [5 + Math.floor(i / 7) * 80, 5 + i % 7 * 40, 80, 40, false] : [165, 5 + (i - 14) * 80, 40, 80, true]);
      assert.equal(a.width * a.height, a.preset.width_mm * a.preset.height_mm);
      assert.ok(a.x >= 5 && a.y >= 5 && a.x + a.width <= 205 && a.y + a.height <= 285);
      for (const b of page.slice(i + 1)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
  }
});
test('混合挂钩与货架沿用既有排版而非17张专用格', () => {
  const pages = packA4([hook(), base()]);
  assert.deepEqual(pages[0]?.map(p => [p.preset.category, p.x, p.y, p.width, p.height, p.rotated]), [['ip', 5, 5, 80, 40, false], ['store_notice', 85, 5, 90, 30, false]]);
});
test('私桶原码隔离、旧dianping目录仅review、停用不签名、不发路径', async () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const row = (purpose: string, folder: string, location = loc, status = 'active') => ({ purpose, status, image_bucket: 'store-qr', image_path: `${location}/${folder}/${id}.png`, updated_at: 'test' });
  const signed: string[] = [];
  const result = await projectQr([row('dianping_review', 'dianping'), row('dianping_checkin', 'dianping'), row('wecom_contact', 'wechat', loc, 'disabled'), row('identify', 'identify', '22222222-2222-4222-8222-222222222222')], loc, async path => { signed.push(path); return 'https://example.test/image'; });
  assert.equal(signed.length, 1);
  assert.deepEqual(result, [{ channel: 'dianping_review', image_url: 'https://example.test/image', updated_at: 'test' }]);
  assert.equal('image_path' in result[0], false);
});
test('扫码模板清单按门店渠道路径校验并与静态目录合并', async () => {
  const { parseQrTemplateManifest, mergeCatalog } = await import('./contract');
  const row = { id: `qr-${loc}-wechat`, type_id: 'qr-wechat', name: '微信', category: 'qr', enabled: true, orientation: 'landscape', width_mm: 90, height_mm: 30, image_path: `/print-presets/qr-templates/${loc}-wechat.pdf`, thumbnail_path: `/print-presets/qr-templates/${loc}-wechat.png`, channel: 'wechat', location_id: loc, qr_box: { x_mm: 63.8, y_mm: 1, size_mm: 25.8 } };
  const qr = parseQrTemplateManifest({ version: 1, presets: [row] });
  assert.equal(mergeCatalog([base()], qr).length, 2);
  assert.throws(() => parseQrTemplateManifest({ version: 1, presets: [{ ...row, image_path: '/print-presets/qr-templates/other.pdf' }] }));
  assert.throws(() => parseQrTemplateManifest({ version: 1, presets: [{ ...row, location_id: undefined }] }));
  assert.throws(() => mergeCatalog(qr, qr));
  assert.throws(() => resolveSelection(qr, [{ id: row.id, quantity: 1 }], loc, ['xiaohongshu']));
});
test('私桶原码路径正则匹配普通 .png/.jpg，拒绝伪扩展', async () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const mk = (path: string) => ({ purpose: 'xiaohongshu', status: 'active', image_bucket: 'store-qr', image_path: path, updated_at: 't' });
  for (const [path, ok] of [[`${loc}/xiaohongshu/${id}.png`, 1], [`${loc}/xiaohongshu/${id}.jpg`, 1], [`${loc}/xiaohongshu/${id}xpng`, 0], [`${loc}/xiaohongshu/${id}\\.png`, 0]] as const)
    assert.equal((await projectQr([mk(path)], loc, async () => 'u')).length, ok, path);
});
