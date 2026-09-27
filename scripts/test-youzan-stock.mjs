import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
globalThis.fetch = async () => { throw Error("Stock regression tests prohibit network access"); };
for (const path of [
  "src/lib/youzan-quantity.test.ts",
  "src/lib/youzan-offline-products.test.ts",
  "src/lib/youzan-archived-stock.test.ts",
]) {
  const bundle = await build({
    entryPoints: [path], bundle: true, write: false, platform: "node", format: "esm", packages: "external",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(resolve(path)).href) },
    plugins: [{ name: "no-live-imports", setup(b) {
      b.onResolve({ filter: /youzan\.functions$/ }, a => ({ path: a.path, external: true }));
    } }],
  });
  await import(`data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=${path}`).toString("base64")}`);
}
