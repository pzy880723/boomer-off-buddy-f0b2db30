import assert from "node:assert/strict";
import { test } from "node:test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { qrPngDataUrl } from "./qr-png.server";

test("server QR PNG decodes back to the exact pickup payload", async () => {
  const payload = `BOOMER_PICKUP:${"ab".repeat(32)}`;
  const url = await qrPngDataUrl(payload);
  assert.match(url, /^data:image\/png;base64,/);
  const png = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, payload);
  assert.notEqual(decoded?.data, "0042");
});
