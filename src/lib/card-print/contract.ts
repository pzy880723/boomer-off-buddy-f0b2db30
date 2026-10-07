import { z } from 'zod';

export const channels = ['xiaohongshu', 'wechat', 'dianping_checkin', 'dianping_review', 'identify', 'miniprogram'] as const;
export type PrintChannel = typeof channels[number];
export const categories = ['qr', 'store_notice', 'ip', 'brand', 'category', 'import_origin', 'product'] as const;
const assetPath = z.string().regex(/^\/(?!\/)[^?#\\]+\.(pdf|png|jpg|jpeg)$/i, '预设必须为同域 PDF/PNG/JPEG 原稿路径');
export const Preset = z.object({
  id: z.string().min(1).max(120), type_id: z.string().min(1).max(120), name: z.string().min(1).max(120),
  category: z.enum(categories), enabled: z.boolean(), orientation: z.enum(['landscape', 'portrait']),
  width_mm: z.number().positive().max(200), height_mm: z.number().positive().max(280), image_path: assetPath,
  thumbnail_path: z.string().optional(), subtitle: z.string().optional(),
  channel: z.enum(channels).optional(), location_id: z.string().uuid().optional(),
  qr_box: z.object({ x_mm: z.number().nonnegative(), y_mm: z.number().nonnegative(), size_mm: z.number().positive() }).strict().optional(),
}).strict().superRefine((p, ctx) => {
  if (p.category === 'qr' && (!p.channel || !p.qr_box || !p.location_id)) ctx.addIssue({ code: 'custom', message: '扫码卡须提供独立用途与原版二维码位置' });
  if (p.category !== 'qr' && (p.channel || p.qr_box)) ctx.addIssue({ code: 'custom', message: '非扫码卡不能绑定二维码' });
  if (p.qr_box && (p.qr_box.x_mm + p.qr_box.size_mm > p.width_mm || p.qr_box.y_mm + p.qr_box.size_mm > p.height_mm)) ctx.addIssue({ code: 'custom', message: '二维码位置超出卡片' });
});
export type CardPreset = z.infer<typeof Preset>;
export const PRESET_MANIFEST_PATH = '/print-presets/print-presets.json';
const nativeCategory = { IP: 'ip', 品牌: 'brand', 品类: 'category', 进口来源: 'import_origin', 店铺提示: 'store_notice' } as const;
const NativePreset = z.object({
  id: z.string().min(1), title: z.string().min(1), subtitle: z.string(),
  category: z.enum(['IP', '品牌', '品类', '进口来源', '店铺提示']),
  widthMM: z.number().positive().max(200), heightMM: z.number().positive().max(280),
  file: z.string().min(1), thumbnail: z.string().min(1), pairID: z.string().nullable(),
}).strict();
function nativeAsset(file: string): string {
  const path = `/print-presets/${file}`;
  if (file.startsWith('/') || file.includes('\\') || file.split('/').some(s => s === '..' || s === '.') || /[?#%]/.test(file)) throw new Error('非法预设资源路径');
  return path;
}
export function parseNativeManifest(input: unknown): CardPreset[] {
  const rows = z.array(NativePreset).max(1000).parse(input);
  if (new Set(rows.map(p => p.id)).size !== rows.length) throw new Error('预设 ID 重复');
  return rows.map(p => Preset.parse({ id: p.id, type_id: p.pairID || p.id, name: p.title, subtitle: p.subtitle,
    category: nativeCategory[p.category], enabled: true, orientation: p.widthMM >= p.heightMM ? 'landscape' : 'portrait',
    width_mm: p.widthMM, height_mm: p.heightMM, image_path: nativeAsset(p.file), thumbnail_path: nativeAsset(p.thumbnail),
  }));
}
export const QR_TEMPLATE_MANIFEST_PATH = '/print-presets/qr-templates.json';
export function parseQrTemplateManifest(input: unknown): CardPreset[] {
  const presets = Manifest.parse(input).presets;
  for (const p of presets) {
    const base = `/print-presets/qr-templates/${p.location_id}-${p.channel}`;
    if (p.category !== 'qr' || !p.location_id || p.image_path !== `${base}.pdf` || (p.thumbnail_path && p.thumbnail_path !== `${base}.png`)) throw new Error('扫码模板路径或门店不符');
  }
  return presets.map(p => ({ ...p, thumbnail_path: p.thumbnail_path ?? `/print-presets/qr-templates/${p.location_id}-${p.channel}.png` }));
}
export function mergeCatalog(statics: CardPreset[], qr: CardPreset[]): CardPreset[] {
  const all = [...statics, ...qr];
  if (new Set(all.map(p => p.id)).size !== all.length) throw new Error('预设 ID 重复');
  return all;
}
export async function loadCatalog(origin: string): Promise<CardPreset[]> {
  const read = async (path: string) => {
    const r = await fetch(sameOriginUrl(path, origin), { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('预设清单暂时不可访问');
    return r.json();
  };
  const [statics, qr] = await Promise.all([read(PRESET_MANIFEST_PATH), read(QR_TEMPLATE_MANIFEST_PATH)]);
  return mergeCatalog(parseNativeManifest(statics), parseQrTemplateManifest(qr));
}
export function assertQrLocation(actual: string | null, selected: string): void {
  if (!selected || actual !== selected) throw new Error('二维码返回门店与所选门店不一致');
}
export const Manifest = z.object({ version: z.literal(1), presets: z.array(Preset).max(1000) }).strict().superRefine((m, ctx) => {
  if (new Set(m.presets.map(p => p.id)).size !== m.presets.length) ctx.addIssue({ code: 'custom', message: '预设 ID 重复' });
});
export function permitted(p: CardPreset): boolean {
  if (!p.enabled) return false;
  if (p.category === 'qr' || p.category === 'store_notice') return p.orientation === 'landscape' && p.width_mm === 90 && p.height_mm === 30;
  if (p.category === 'product') return p.width_mm === 60 && p.height_mm === 90 && p.orientation === 'portrait';
  if (p.width_mm === 80 && p.height_mm === 40) return p.orientation === 'landscape' && (p.category === 'ip' || p.category === 'category');
  return p.orientation === (p.width_mm >= p.height_mm ? 'landscape' : 'portrait');
}
export const cardSpecifications = [
  { value: 'all', label: '全部规格' },
  { value: 'hook', label: '挂钩卡 80×40mm', width: 80, height: 40 },
  { value: 'shelf', label: '货架横卡 90×30mm', width: 90, height: 30 },
  { value: 'standing', label: '介绍立牌 80×120mm', width: 80, height: 120 },
] as const;
export function matchesSpecification(p: CardPreset, specification: string): boolean {
  const spec = cardSpecifications.find(s => s.value === specification);
  if (!spec) return false;
  return spec.value === 'all' || (p.width_mm === spec.width && p.height_mm === spec.height);
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
  if (cards.length && cards.every(p => p.width_mm === 80 && p.height_mm === 40)) {
    if (cards.some(p => !permitted(p))) throw new Error('禁止输出停用卡片');
    const pages: Placement[][] = [];
    for (let offset = 0; offset < cards.length; offset += 17) {
      pages.push(cards.slice(offset, offset + 17).map((preset, index) => index < 14
        ? { preset, x: 5 + Math.floor(index / 7) * 80, y: 5 + index % 7 * 40, width: 80, height: 40, rotated: false }
        : { preset, x: 165, y: 5 + (index - 14) * 80, width: 40, height: 80, rotated: true }));
    }
    return pages;
  }
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
