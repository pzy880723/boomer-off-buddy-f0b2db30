// 服务端二维码 PNG（纯脚本：uqr 生成矩阵 + CompressionStream 压缩），可在 Workers 运行；不落盘、不出公开 URL。
import { encode } from "uqr";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function qrPngDataUrl(text: string, opts: { scale?: number; margin?: number } = {}): Promise<string> {
  const scale = opts.scale ?? 8;
  const margin = opts.margin ?? 4;
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  const px = (size + margin * 2) * scale;
  const raw = new Uint8Array(px * (px + 1));
  for (let y = 0; y < px; y++) {
    const row = y * (px + 1);
    raw[row] = 0; // filter none
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - margin;
      const dark = my >= 0 && my < size && mx >= 0 && mx < size && data[my][mx];
      raw[row + 1 + x] = dark ? 0 : 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, px);
  dv.setUint32(4, px);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  let bin = "";
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
