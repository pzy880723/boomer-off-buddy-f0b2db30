import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCardPdf } from './pdf';
import type { CardPreset } from './contract';

test('单卡PDF直接嵌入A4、重复原尺寸拼版、拒绝多页和错误尺寸', async () => {
  const original = await PDFDocument.create();
  const page = original.addPage([90 * 72 / 25.4, 30 * 72 / 25.4]);
  const font = await original.embedFont(StandardFonts.Helvetica);
  page.drawText('APPROVED ORIGINAL', { x: 12, y: 35, size: 10, font });
  const bytes = await original.save();
  const p: CardPreset = { id: 'one', type_id: 'one', name: 'original', category: 'store_notice', enabled: true, orientation: 'landscape', width_mm: 90, height_mm: 30, image_path: '/print-presets/one.pdf' };
  const fetchBefore = globalThis.fetch;
  const locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://erp.test' } });
  globalThis.fetch = async () => new Response(Uint8Array.from(bytes));
  try {
    const result = await PDFDocument.load(await createCardPdf(Array.from({ length: 18 }, () => p), [], 'https://erp.test'));
    assert.equal(result.getPageCount(), 1);
    assert.ok(Math.abs(result.getPage(0).getWidth() - 210 * 72 / 25.4) < 0.01);
    await assert.rejects(createCardPdf([{ ...p, width_mm: 89 }], [], 'https://erp.test'), /尺寸/);
    original.addPage();
    const multi = await original.save();
    globalThis.fetch = async () => new Response(Uint8Array.from(multi));
    await assert.rejects(createCardPdf([p], [], 'https://erp.test'), /尺寸/);
  } finally {
    globalThis.fetch = fetchBefore;
    if (locationBefore) Object.defineProperty(globalThis, 'location', locationBefore);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});