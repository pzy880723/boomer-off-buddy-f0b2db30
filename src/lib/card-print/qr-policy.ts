import { channels, type PrintChannel } from './contract';
export const purposes: Record<PrintChannel, string> = { wechat: 'wecom_contact', xiaohongshu: 'xiaohongshu', dianping_checkin: 'dianping_checkin', dianping_review: 'dianping_review', identify: 'identify', miniprogram: 'mini_program' };
export type QrImage = { channel: PrintChannel; image_url: string; updated_at: string };
export type QrRecord = { purpose: string; status: string; image_bucket: string | null; image_path: string | null; updated_at: string };
export async function projectQr(rows: QrRecord[], locationId: string, sign: (path: string) => Promise<string | null>): Promise<QrImage[]> {
  const output: QrImage[] = [];
  for (const channel of channels) {
    const row = rows.find(r => r.purpose === purposes[channel]);
    if (!row || row.status !== 'active' || row.image_bucket !== 'store-qr' || !row.image_path) continue;
    const folder = channel === 'dianping_review' ? '(dianping_review|dianping)' : channel;
    if (!new RegExp(`^${locationId}/${folder}/[0-9a-f-]{36}\\.(png|jpg)$`).test(row.image_path)) continue;
    const url = await sign(row.image_path);
    if (!url) throw new Error('门店二维码暂时无法读取，请重试');
    output.push({ channel, image_url: url, updated_at: row.updated_at });
  }
  return output;
}
