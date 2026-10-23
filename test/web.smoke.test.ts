// Boots wire-web on a fixture copy of state.json and checks every page renders and its browser code parses.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { fixture, inlineScripts, startWeb } from "./helpers";

let web: Awaited<ReturnType<typeof startWeb>>;
beforeAll(async () => { web = await startWeb({ LOCAL_STATE: fixture("state.json"), ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}) }); });
afterAll(() => web?.stop());

const pages: [string, string][] = [["/", "Liverpool FC news"], ["/filtered", "Kept out"], ["/status", "Schedule and alerts"], ["/shorts", "Shorts"]];
for (const [path, marker] of pages) {
  test(`${path} renders`, async () => {
    const r = await fetch(web.url + path);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(marker);
    expect(html).not.toContain("Something went wrong");
    for (const src of inlineScripts(html)) expect(() => new Function(src)).not.toThrow();
  });
}

test("static assets and APIs answer", async () => {
  for (const p of ["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/api/version", "/api/push/key"]) expect((await fetch(web.url + p)).status).toBe(200);
  expect((await fetch(web.url + "/nope")).status).toBe(404);
  const sw = await (await fetch(web.url + "/sw.js")).text();
  expect(() => new Function(sw)).not.toThrow();
});

test("server logged no errors", () => {
  expect(web.log()).not.toMatch(/render failed|TypeError|ReferenceError/);
});
