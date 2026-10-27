import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute = () => options => options;",
  "@/server/ai-consent.server": `export const requireAiActor = async () => ({ok:true,userId:'test',device:{id:'test'},guard:{check:async()=>{}}}); export const aiConsentErrorResponse = () => null;`,
  "@/server/handheld-auth.server": `export const HANDHELD_CORS = {}; export const ok = data => Response.json({ok:true,data}); export const err = (error,status=400,extra={}) => Response.json({ok:false,error,...extra},{status});`,
  "@/lib/handheld/schemas": "export const AiListingImageReq = {parse: x => x};",
  "@/server/handheld-ai.server": `export const aiPrepareListingImage = async () => {const s=globalThis.__retouchScenario;if(s.phase==='generation') throw s.error; return {b64:'YQ==',mime:'image/png'};};`,
  "@/integrations/supabase/client.server": `export const supabaseAdmin = {storage:{from:()=>({upload:async()=>{if(globalThis.__retouchScenario.phase==='upload') throw globalThis.__retouchScenario.error; return {error:null};},createSignedUrl:async()=>{if(globalThis.__retouchScenario.phase==='sign') throw globalThis.__retouchScenario.error; return {error:null,data:{signedUrl:'test'}};}})}};`,
  "@/server/retouch-receipt.server": `export const recordValidatedRetouch = async () => {if(globalThis.__retouchScenario.phase==='receipt') throw globalThis.__retouchScenario.error;};`,
};
const bundle = await build({entryPoints:["src/routes/api/public/handheld/ai.prepare-listing-image.ts"],bundle:true,write:false,platform:"node",format:"esm",
  plugins:[{name:"stubs",setup(b: any){b.onResolve({filter:/.*/},(a: any)=> stubs[a.path] ? {path:a.path,namespace:"stub"} : undefined);b.onLoad({filter:/.*/,namespace:"stub"},(a: any)=>({contents:stubs[a.path],loader:"js"}));}}]});
const { Route } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const cases = [
  ["empty stop", "image_generation", "图像生成服务未返回图片（stop），原图保留", 30],
  ["quality", "image_validation", "修图检查未通过（fields=product_present），原图保留", 30],
  ["5xx", "image_generation", "AI gateway 503", 30],
  ["classification", "measurement_detection", "Image classification HTTP 503", 30],
  ["429", "image_generation", "AI gateway 429", 900],
  ["refusal", "image_generation", "图像生成服务未返回图片（refusal），原图保留", null],
  ["consent", "image_generation", "consent revoked", null],
  ["source", "image_generation", "invalid source", null],
  ["unknown", "image_generation", "unknown", null],
  ["missing stage", undefined, "AI gateway 503", null],
] as const;
for (const [name,stage,message,delay] of cases) {
  test(`route only exposes safe retry contract for ${name}`, async () => {
    (globalThis as any).__retouchScenario = {phase:"generation",error:Object.assign(new Error(message),{stage})};
    const response = await Route.server.handlers.POST({request: new Request("http://localhost/test",{method:"POST",body:"{}"})});
    const body = await response.json();
    assert.equal(response.status,502);
    assert.equal(body.code,delay === null ? undefined : "retouch_retryable");
    assert.equal(body.retry_after_seconds,delay ?? undefined);
  });
}
for (const phase of ["upload","receipt","sign"]) {
  test(`${phase} error cannot charge a second generation`, async () => {
    (globalThis as any).__retouchScenario = {phase,error:Object.assign(new Error("AI gateway 503"),{stage:"image_generation",status:503})};
    const response = await Route.server.handlers.POST({request:new Request("http://localhost/test",{method:"POST",body:"{}"})});
    const body = await response.json();
    assert.equal(body.code,undefined);
    assert.equal(body.retry_after_seconds,undefined);
  });
}
test("success response stays unchanged", async () => {
  (globalThis as any).__retouchScenario = {phase:"success"};
  const response = await Route.server.handlers.POST({request:new Request("http://localhost/test",{method:"POST",body:"{}"})});
  const body = await response.json();
  assert.equal(response.status,200);
  assert.equal(body.ok,true);
  assert.equal(body.data.signed_url,"test");
  assert.equal(body.data.mime_type,"image/png");
  assert.equal(body.data.preserved_original,false);
  assert.equal(body.data.warning,null);
  assert.equal(body.code,undefined);
});