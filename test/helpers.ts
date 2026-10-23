// Shared test helpers: fixture files, a free port, and a server that is always stopped.
import { gunzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wire-fixtures-"));

/** Decompress test/fixtures/<name>.gz to a temp file and return its path. */
export function fixture(name: string): string {
  const out = join(dir, name);
  writeFileSync(out, gunzipSync(new Uint8Array(require("node:fs").readFileSync(join(import.meta.dir, "fixtures", `${name}.gz`)))));
  return out;
}

export function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port; s.stop(true); return p!;
}

/** Start a service with the given env and wait until /health answers. */
export async function startWeb(env: Record<string, string>): Promise<{ url: string; stop: () => void; log: () => string }> {
  const port = freePort();
  let out = "";
  const proc = Bun.spawn(["bun", "run", "services/wire-web/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", PORT: String(port), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  for (const s of [proc.stdout, proc.stderr]) (async () => { for await (const c of s) out += new TextDecoder().decode(c); })();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/health")).ok) return { url, stop: () => proc.kill(), log: () => out }; } catch {}
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error("wire-web did not start:\n" + out);
}

/** Every inline <script> must at least parse, or the page's interactivity is silently dead. */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}
