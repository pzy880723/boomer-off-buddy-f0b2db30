/**
 * 公开的在线 API 文档页面，使用 Scalar API Reference (CDN) 渲染
 * /api/public/handheld/openapi.json。
 * 服务端直出 HTML，不走 React，避免 SSR / 客户端水合开销。
 */
import { createFileRoute } from "@tanstack/react-router";

const HTML = /* html */ `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Boomer Off — 手持终端 API 文档</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Boomer Off handheld terminal public API reference." />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #0b0b0f; }
    </style>
  </head>
  <body>
    <script id="api-reference" data-url="/api/public/handheld/openapi.json"></script>
    <script>
      var configuration = {
        theme: 'purple',
        layout: 'modern',
        hideDownloadButton: false,
        defaultOpenAllTags: true,
      };
      var el = document.getElementById('api-reference');
      el.dataset.configuration = JSON.stringify(configuration);
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export const Route = createFileRoute("/api-docs")({
  server: {
    handlers: {
      GET: async () =>
        new Response(HTML, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        }),
    },
  },
});
