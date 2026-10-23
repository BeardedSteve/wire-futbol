// Design harness server. Serves the pages and the htmx fragments from the fixture data so the design can be used, not just looked at.
// Run: bun run design/serve.ts   (PORT defaults to 3100)
//   ?now=2026-10-25T10:20:00Z   move the clock (matchday, live, full time)
//   ?club=demo-blue             try another club's tokens        ?theme=dark|light   force a theme
import { join } from "node:path";
import { demoNow } from "./data.ts";
import { pulse, playerStrips, setNow, shortsPage, spikedPage, spikedResults, squadPage, statusPage, tablePage, wirePage } from "./render.ts";

const root = import.meta.dir;
const type: Record<string, string> = { css: "text/css", js: "text/javascript", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png" };
const html = (b: string) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "HX-Request, HX-Target" } });

// The time machine is a harness feature only. It is appended to every full page, never to fragments.
const SCENES: [string, string][] = [
  ["Quiet", "2026-10-23T08:40:00Z"], ["Matchday", "2026-10-25T10:20:00Z"], ["Live", "2026-10-25T14:57:00Z"], ["Full time", "2026-10-17T16:45:00Z"],
];
const demoBar = (u: URL) => `<style>.demo{position:fixed;z-index:99;left:12px;top:12px;display:flex;gap:2px;font:600 11px/1 "IBM Plex Mono",monospace;background:#222;color:#fff;padding:4px;border:1px solid #666}
.demo a{color:#fff;padding:7px 9px;text-decoration:none;border-radius:3px}.demo a:hover,.demo a.on{background:#fff3}.demo span{padding:7px 6px 7px 8px;opacity:.6}</style>
<div class="demo" hx-disable><span>Clock</span>${SCENES.map(([l, t]) => `<a href="${u.pathname}?now=${t}${u.searchParams.get("club") ? `&club=${u.searchParams.get("club")}` : ""}" ${u.searchParams.get("now") === t ? 'class="on"' : ""}>${l}</a>`).join("")}${["lfc", "demo-blue", "demo-gold"].map((c) => `<a href="?club=${c}${u.searchParams.get("now") ? `&now=${u.searchParams.get("now")}` : ""}">${c}</a>`).join("")}</div>`;

Bun.serve({
  port: Number(Bun.env.PORT || 3100),
  async fetch(req) {
    const u = new URL(req.url), p = u.pathname, hxTarget = req.headers.get("hx-target");
    if (p === "/health") return new Response("ok");
    if (p.startsWith("/static/")) {
      const f = Bun.file(join(root, p));
      return (await f.exists()) && !p.includes("..") ? new Response(f, { headers: { "content-type": type[p.split(".").pop()!] ?? "application/octet-stream", "cache-control": "no-cache" } }) : new Response("Not found", { status: 404 });
    }
    if (p === "/sw.js") return new Response(Bun.file(join(root, "static/js/sw.js")), { headers: { "content-type": "text/javascript", "service-worker-allowed": "/" } });
    if (p === "/api/push/key") return Response.json({ key: "" });
    setNow(demoNow(u.searchParams.get("now")), !!u.searchParams.get("now"));
    const club = u.searchParams.get("club"), theme = u.searchParams.get("theme");
    const page = (b: string) => {
      if (req.headers.get("hx-request") && hxTarget !== "body" && hxTarget) return html(b); // fragment
      b = b.replace(/<html lang="en-GB" data-club="[^"]*"/, `<html lang="en-GB" data-club="${club ?? "lfc"}"${theme ? ` data-theme="${theme}"` : ""}`);
      return html(u.searchParams.get("demo") === "0" ? b : b.replace("</body>", demoBar(u) + "</body>"));
    };
    try {
      if (p === "/") return page(wirePage(u.searchParams.get("desk") ?? "all", hxTarget));
      if (p === "/fragments/pulse") return html(pulse(u.searchParams.get("run") ?? "", Number(u.searchParams.get("n") ?? 0)));
      if (p === "/squad") return page(squadPage());
      if (p.startsWith("/squad/player/")) return html(playerStrips(Number(p.split("/").pop())));
      if (p === "/spiked") {
        const q = u.searchParams.get("q") ?? "", bucket = u.searchParams.get("bucket") ?? "";
        return hxTarget === "spiked-results" ? html(spikedResults(q, bucket)) : page(spikedPage(q, bucket));
      }
      if (p === "/table") return page(tablePage());
      if (p === "/status") return page(statusPage());
      if (p === "/shorts") return page(shortsPage());
    } catch (e) { console.error("render failed", p, e); return new Response("Something went wrong rendering this page.", { status: 500 }); }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`design harness on :${Bun.env.PORT || 3100}`);
