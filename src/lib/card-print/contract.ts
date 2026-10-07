import { z } from 'zod';

export const channels = ['xiaohongshu', 'wechat', 'dianping_checkin', 'dianping_review', 'identify', 'miniprogram'] as const;
export type PrintChannel = typeof channels[number];
export const categories = ['qr', 'store_notice', 'ip', 'brand', 'category', 'import_origin', 'product'] as const;
const assetPath = z.string().regex(/^\/(?!\/)[^?#\\]+\.(png|jpg|jpeg)$/i, '预设图片必须为同域 PNG/JPEG 原图路径');
export const Preset = z.object({
  id: z.string().min(1).max(120), type_id: z.string().min(1).max(120), name: z.string().min(1).max(120),
  category: z.enum(categories), enabled: z.boolean(), orientation: z.enum(['landscape', 'portrait']),
  width_mm: z.number().positive().max(200), height_mm: z.number().positive().max(280), image_path: assetPath,
  channel: z.enum(channels).optional(), location_id: z.string().uuid().optional(),
  qr_box: z.object({ x_mm: z.number().nonnegative(), y_mm: z.number().nonnegative(), size_mm: z.number().positive() }).strict().optional(),
}).strict().superRefine((p, ctx) => {
  if (p.category === 'qr' && (!p.channel || !p.qr_box)) ctx.addIssue({ code: 'custom', message: '扫码卡须提供独立用途与原版二维码位置' });
  if (p.category !== 'qr' && (p.channel || p.qr_box)) ctx.addIssue({ code: 'custom', message: '非扫码卡不能绑定二维码' });
  if (p.qr_box && (p.qr_box.x_mm + p.qr_box.size_mm > p.width_mm || p.qr_box.y_mm + p.qr_box.size_mm > p.height_mm)) ctx.addIssue({ code: 'custom', message: '二维码位置超出卡片' });
});
export type CardPreset = z.infer<typeof Preset>;
export const Manifest = z.object({ version: z.literal(1), presets: z.array(Preset).max(1000) }).strict().superRefine((m, ctx) => {
  if (new Set(m.presets.map(p => p.id)).size !== m.presets.length) ctx.addIssue({ code: 'custom', message: '预设 ID 重复' });
});
export function permitted(p: CardPreset): boolean {
  if (!p.enabled) return false;
  if (p.category === 'qr' || p.category === 'store_notice') return p.orientation === 'landscape' && p.width_mm === 90 && p.height_mm === 30;
  if (p.category === 'product') return p.width_mm === 60 && p.height_mm === 90 && p.orientation === 'portrait';
  return p.orientation === (p.width_mm >= p.height_mm ? 'landscape' : 'portrait');
}
export type Selection = { id: string; quantity: number };
export const SelectionSchema = z.array(z.object({ id: z.string(), quantity: z.number().int().min(1).max(100) }).strict()).max(200);
export function resolveSelection(presets: CardPreset[], input: unknown, locationId: string, availableChannels: PrintChannel[]): CardPreset[] {
  const selected = SelectionSchema.parse(input);
  if (new Set(selected.map(s => s.id)).size !== selected.length) throw new Error('重复的预设选择');
  const cards: CardPreset[] = [];
  for (const s of selected) {
    const p = presets.find(p => p.id === s.id);
    if (!p || !permitted(p)) throw new Error('所选预设已停用或尺寸不允许，请重新选择');
    if (p.location_id && p.location_id !== locationId) throw new Error('预设不属于当前门店');
    if (p.category === 'qr' && (!p.channel || !availableChannels.includes(p.channel))) throw new Error('当前门店缺少此用途二维码');
    for (let i = 0; i < s.quantity; i++) cards.push(p);
  }
  if (!cards.length || cards.length > 500) throw new Error('请选择 1–500 张卡片');
  return cards;
}
export type Placement = { preset: CardPreset; x: number; y: number; width: number; height: number; rotated: boolean };
export function packA4(cards: CardPreset[]): Placement[][] {
  // Integer millimetres are not assumed: all positions remain in physical mm.
  const pages: Placement[][] = [];
  const pending = [...cards].sort((a, b) => b.width_mm * b.height_mm - a.width_mm * a.height_mm);
  while (pending.length) {
    const page: Placement[] = [];
    let spaces = [{ x: 5, y: 5, width: 200, height: 280 }];
    for (let i = 0; i < pending.length;) {
      const p = pending[i];
      if (!p || !permitted(p)) throw new Error('禁止输出停用卡片');
      const choices = spaces.flatMap((s, index) => [false, true].flatMap(rotated => {
        const width = rotated ? p.height_mm : p.width_mm, height = rotated ? p.width_mm : p.height_mm;
        return width <= s.width && height <= s.height ? [{ index, rotated, width, height, waste: s.width * s.height - width * height }] : [];
      })).sort((a, b) => a.waste - b.waste || Number(a.rotated) - Number(b.rotated));
      const best = choices[0];
      if (!best) { i++; continue; }
      const s = spaces[best.index];
      if (!s) throw new Error('拼版位置无效');
      page.push({ preset: p, x: s.x, y: s.y, width: best.width, height: best.height, rotated: best.rotated });
      spaces.splice(best.index, 1);
      spaces.push({ x: s.x + best.width, y: s.y, width: s.width - best.width, height: best.height }, { x: s.x, y: s.y + best.height, width: s.width, height: s.height - best.height });
      spaces = spaces.filter(s => s.width > 0 && s.height > 0);
      pending.splice(i, 1);
    }
    if (!page.length) throw new Error('卡片尺寸无法放入 A4');
    pages.push(page);
  }
  return pages;
}
export function sameOriginUrl(path: string, origin: string): string {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.hash || url.search || /(^|\/)\.\.(\/|$)/.test(decodeURIComponent(path)) || path.includes('\\')) throw new Error('仅允许腾讯同域静态资源');
  return url.href;
}
