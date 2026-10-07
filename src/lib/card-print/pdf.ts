import { PDFDocument, PDFEmbeddedPage, degrees, rgb, type PDFImage } from 'pdf-lib';
import { packA4, sameOriginUrl, type CardPreset } from './contract';
import type { QrImage } from './qr-policy';
const mm = (n: number) => n * 72 / 25.4;
async function imageBytes(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), credentials: new URL(url).origin === location.origin ? 'same-origin' : 'omit' });
  if (!response.ok) throw new Error('原图读取失败，未生成打印文件');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25_000_000) throw new Error('图片过大');
  return bytes;
}
async function embed(doc: PDFDocument, bytes: Uint8Array) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return doc.embedPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return doc.embedJpg(bytes);
  throw new Error('预设原图须为 PNG/JPEG');
}
export async function createCardPdf(cards: CardPreset[], qr: QrImage[], origin: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('BOOMER OFF · A4 cards');
  const originals = new Map<string, PDFEmbeddedPage | PDFImage>();
  for (const p of cards) {
    if (!originals.has(p.image_path)) {
      const bytes = await imageBytes(sameOriginUrl(p.image_path, origin));
      if (p.image_path.toLowerCase().endsWith('.pdf')) {
        const source = await PDFDocument.load(bytes);
        const first = source.getPage(0);
        if (source.getPageCount() !== 1 || Math.abs(first.getWidth() - mm(p.width_mm)) > 1 || Math.abs(first.getHeight() - mm(p.height_mm)) > 1) throw new Error('原版PDF尺寸与清单不一致，禁止缩放输出');
        const [embedded] = await doc.embedPdf(source, [0]);
        if (!embedded) throw new Error('原版PDF无法嵌入');
        originals.set(p.image_path, embedded);
      } else originals.set(p.image_path, await embed(doc, bytes));
    }
  }
  const codes = new Map<string, Awaited<ReturnType<typeof embed>>>();
  for (const channel of new Set(cards.flatMap(p => p.channel ? [p.channel] : []))) {
    const image = qr.find(q => q.channel === channel);
    if (!image) throw new Error('门店缺少此用途原始二维码');
    codes.set(channel, await embed(doc, await imageBytes(image.image_url)));
  }
  for (const placements of packA4(cards)) {
    const page = doc.addPage([mm(210), mm(297)]);
    for (const c of placements) {
      const original = originals.get(c.preset.image_path);
      if (!original) throw new Error('预设原图缺失');
      const x = mm(c.x), y = mm(297 - c.y - c.height);
      const placement = c.rotated ? { x: x + mm(c.width), y, width: mm(c.preset.width_mm), height: mm(c.preset.height_mm), rotate: degrees(90) } : { x, y, width: mm(c.width), height: mm(c.height) };
      if (original instanceof PDFEmbeddedPage) page.drawPage(original, placement);
      else page.drawImage(original, placement);
      const box = c.preset.qr_box, code = c.preset.channel ? codes.get(c.preset.channel) : undefined;
      if (box && code) {
        const qx = c.rotated ? box.y_mm : box.x_mm;
        const qy = c.rotated ? c.preset.width_mm - box.x_mm - box.size_mm : box.y_mm;
        page.drawImage(code, { x: x + mm(qx), y: y + mm(c.height - qy - box.size_mm), width: mm(box.size_mm), height: mm(box.size_mm) });
      }
      page.drawRectangle({ x, y, width: mm(c.width), height: mm(c.height), borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.2 });
      for (const cx of [x, x + mm(c.width)]) for (const cy of [y, y + mm(c.height)]) {
        // Corner cutting ticks are kept inside the finished card so adjacent cards stay zero-gap.
        const dx = cx === x ? 1 : -1, dy = cy === y ? 1 : -1;
        page.drawLine({ start: { x: cx, y: cy }, end: { x: cx + mm(1.5) * dx, y: cy }, thickness: 0.3 });
        page.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy + mm(1.5) * dy }, thickness: 0.3 });
      }
    }
    page.drawLine({ start: { x: mm(5), y: mm(5) }, end: { x: mm(55), y: mm(5) }, thickness: 0.5 });
    for (let i = 0; i <= 50; i += 10) page.drawLine({ start: { x: mm(5 + i), y: mm(4) }, end: { x: mm(5 + i), y: mm(6) }, thickness: 0.5 });
    page.drawText('50 mm | A4 | 100%', { x: mm(60), y: mm(4), size: 7 });
  }
  return doc.save();
}
