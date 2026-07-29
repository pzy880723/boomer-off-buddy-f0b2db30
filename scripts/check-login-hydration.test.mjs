import assert from "node:assert/strict";
import test from "node:test";

import { findExecutableModuleScript } from "./check-login-hydration.mjs";

test("rejects an SSR login page that only preloads JavaScript", () => {
  const html = `
    <link rel="modulepreload" href="/assets/index-old.js">
    <script class="$tsr">window.__manifest = { entry: "/assets/index-old.js" }</script>
    <button disabled>登录后台</button>
  `;

  assert.equal(findExecutableModuleScript(html), null);
});

test("finds the executable client module in a hydrated login page", () => {
  const html = `
    <link rel="modulepreload" href="/assets/index-new.js">
    <script type="module" async src="/assets/index-new.js"></script>
  `;

  assert.equal(findExecutableModuleScript(html), "/assets/index-new.js");
});
