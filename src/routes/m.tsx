import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/m")({
  head: () => ({
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" },
      { name: "theme-color", content: "#0F172A" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "BO 仓库" },
      { title: "BOOMER OFF · 仓库工作台" },
    ],
    links: [
      { rel: "manifest", href: "/m-manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/m-icon-512.png" },
    ],
  }),
  component: () => <Outlet />,
});
