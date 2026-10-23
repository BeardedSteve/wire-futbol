// Runs squad-poller on fixture FPL data into Postgres, then checks the squad page end to end.
// Needs DATABASE_URL (CI provides a Postgres service). Drops and recreates the fpl_* tables.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixture, inlineScripts, startWeb } from "./helpers";

const DB = process.env.DATABASE_URL;
const t = DB ? test : test.skip;
const root = join(import.meta.dir, "..");
const NOW = "2026-10-23T08:30:00Z"; // when the fixtures were captured

async function poll(env: Record<string, string>) {
  const p = Bun.spawn(["bun", "run", "services/squad-poller/index.ts"], {
    cwd: root, env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", DATABASE_URL: DB!, NOW_OVERRIDE: NOW, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}
const good = () => ({ FPL_BOOT_FILE: fixture("fpl-bootstrap.json"), FPL_FIXTURES_FILE: fixture("fpl-fixtures.json") });

let sql: SQL, web: Awaited<ReturnType<typeof startWeb>>, down: Awaited<ReturnType<typeof startWeb>>;
beforeAll(async () => {
  if (!DB) return;
  sql = new SQL(DB);
  await sql`drop table if exists fpl_players, fpl_teams, fpl_fixtures, fpl_snapshots, fpl_status_events, fpl_runs`;
});
afterAll(async () => { web?.stop(); down?.stop(); await sql?.close(); });

t("first poll loads every player, fixture and existing injury", async () => {
  const r = await poll(good());
  expect(r.code).toBe(0);
  expect(r.out).toContain("squad poll ok: season 2026/27, 668 players");
  const [{ n }] = await sql`select count(*)::int n from fpl_players`;
  expect(n).toBe(668);
  const [{ f }] = await sql`select count(*)::int f from fpl_fixtures where finished and appeared_h is not null`;
  expect(f).toBe(70);
});

t("a second identical poll records no status changes", async () => {
  const r = await poll(good());
  expect(r.code).toBe(0);
  expect(r.out).toContain(" 0 status changes");
});

t("a non-JSON or truncated payload fails without touching stored data", async () => {
  const before = await sql`select md5(string_agg(id || status || minutes, ',' order by id)) h from fpl_players`;
  const bad = join(tmpdir(), "fpl-bad.json");
  writeFileSync(bad, "<html>The game is being updated.</html>");
  const r = await poll({ ...good(), FPL_BOOT_FILE: bad });
  expect(r.code).toBe(1);
  const after = await sql`select md5(string_agg(id || status || minutes, ',' order by id)) h from fpl_players`;
  expect(after[0].h).toBe(before[0].h);
  const [last] = await sql`select ok, error from fpl_runs order by at desc, id desc limit 1`;
  expect(last.ok).toBe(false);
});

t("squad page renders from the database", async () => {
  await poll(good()); // leave a good run as the latest
  web = await startWeb({ LOCAL_STATE: fixture("state.json"), DATABASE_URL: DB! });
  const r = await fetch(web.url + "/squad");
  expect(r.status).toBe(200);
  const html = await r.text();
  for (const s of ["Out now", "Goalkeepers", "Defenders", "Midfielders", "Forwards", "Availability", "Isak", "Szoboszlai"]) expect(html).toContain(s);
  expect(html).not.toContain("isn't loaded yet");
  const data = JSON.parse(html.match(/<script type="application\/json" id="sq-data">([\s\S]*?)<\/script>/)![1]);
  expect(Object.keys(data.pools)).toEqual(["1", "2", "3", "4"]);
  for (const src of inlineScripts(html)) expect(() => new Function(src)).not.toThrow();
  const status = await (await fetch(web.url + "/status")).text();
  expect(status).toMatch(/Squad data<\/dt><dd class="">Refreshed/);
  expect(web.log()).not.toMatch(/render failed|squad read failed|TypeError|ReferenceError/);
});

t("with the database unreachable the wire still works and the squad page says so", async () => {
  down = await startWeb({ LOCAL_STATE: fixture("state.json"), DATABASE_URL: "postgres://nobody@127.0.0.1:9/none" });
  const started = Date.now();
  expect((await fetch(down.url + "/")).status).toBe(200);
  const sq = await fetch(down.url + "/squad");
  expect(sq.status).toBe(200);
  expect(await sq.text()).toContain("isn&#39;t loaded yet");
  expect((await fetch(down.url + "/status")).status).toBe(200);
  expect(Date.now() - started).toBeLessThan(6000);
});
