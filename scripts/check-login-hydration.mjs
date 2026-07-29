import { pathToFileURL } from "node:url";

export function findExecutableModuleScript(html) {
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];

  for (const tag of scriptTags) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) return src;
  }

  return null;
}

export async function checkLoginHydration(baseUrl, fetchImpl = fetch) {
  const loginUrl = new URL("/login", baseUrl);
  const response = await fetchImpl(loginUrl, {
    headers: { "cache-control": "no-cache" },
  });

  if (!response.ok) {
    throw new Error(`Login page returned HTTP ${response.status}`);
  }

  const html = await response.text();
  if (!html.includes("登录后台")) {
    throw new Error("Login page did not contain the ERP login form");
  }

  const moduleSrc = findExecutableModuleScript(html);
  if (!moduleSrc) {
    throw new Error("Login page has no executable module script; the SSR form cannot hydrate");
  }

  const moduleUrl = new URL(moduleSrc, loginUrl);
  const moduleResponse = await fetchImpl(moduleUrl, {
    headers: { "cache-control": "no-cache" },
  });

  if (!moduleResponse.ok) {
    throw new Error(`Client module returned HTTP ${moduleResponse.status}`);
  }

  const moduleCode = await moduleResponse.text();
  if (!moduleCode.includes("hydrateRoot")) {
    throw new Error("Client module does not contain the React hydration entry");
  }

  return { loginUrl: loginUrl.href, moduleUrl: moduleUrl.href };
}

async function main() {
  const baseUrl = process.argv[2] ?? process.env.ERP_BASE_URL ?? "http://127.0.0.1:3005";
  const result = await checkLoginHydration(baseUrl);
  console.log(`Login hydration OK: ${result.moduleUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
