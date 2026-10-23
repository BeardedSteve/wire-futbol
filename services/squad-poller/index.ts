// LFC wire: squad poller. Reads the Fantasy Premier League API on a schedule and keeps every Premier League player,
// fixture, daily snapshot and injury-status change in Postgres. wire-web computes all stats from these tables.
// Runs to completion on each cron tick. Writes nothing unless the payload passes sanity checks.
import { SQL } from "bun";

const env = Bun.env;
const API = "https://fantasy.premierleague.com/api/";
const UA = "lfc-wire/1.0 (+https://lfc.wire.futbol)";
const TZ = "Europe/London";
const sql = new SQL(env.DATABASE_URL!);
const started = Date.now();
const now = env.NOW_OVERRIDE ? new Date(env.NOW_OVERRIDE) : new Date(); // local testing only

async function get(path: string, file?: string): Promise<any> {
  if (file) return JSON.parse(await Bun.file(file).text());
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(API + path, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`${path} returned HTTP ${r.status}`);
      const t = await r.text();
      try { return JSON.parse(t); } catch { throw new Error(`${path} was not JSON (FPL may be mid-update): ${t.slice(0, 80)}`); }
    } catch (e) { last = e; if (i === 0) await Bun.sleep(5_000); }
  }
  throw last;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const londonDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function schema() {
  await sql`create table if not exists fpl_teams (season text not null, id int not null, code int, name text, short_name text, primary key (season, id))`;
  await sql`create table if not exists fpl_players (
    season text not null, id int not null, code int, team int, pos smallint, web_name text, first_name text, second_name text, known_name text,
    minutes int, starts int, goals int, assists int, xg numeric(7,2), xa numeric(7,2),
    saves int, goals_conceded int, xgc numeric(7,2), clean_sheets int, defcon int, recoveries int, tackles int, cbi int,
    status text, chance smallint, news text, news_added timestamptz, removed boolean, updated_at timestamptz,
    primary key (season, id))`;
  await sql`create table if not exists fpl_fixtures (
    season text not null, id int not null, event int, kickoff timestamptz, team_h int, team_a int, h_score int, a_score int,
    finished boolean, appeared_h int[], appeared_a int[], primary key (season, id))`;
  await sql`create table if not exists fpl_snapshots (
    season text not null, id int not null, day date not null, minutes int, goals int, assists int, xg numeric(7,2), xa numeric(7,2),
    status text, chance smallint, primary key (season, id, day))`;
  await sql`create table if not exists fpl_status_events (
    season text not null, id int not null, at timestamptz not null, status text, chance smallint, news text, prev_status text,
    primary key (season, id, at))`;
  await sql`create table if not exists fpl_runs (id bigserial primary key, at timestamptz not null, ok boolean, season text, players int, events int, error text, ms int)`;
}

async function run() {
  await schema();
  const [boot, fixtures] = await Promise.all([get("bootstrap-static/", env.FPL_BOOT_FILE), get("fixtures/", env.FPL_FIXTURES_FILE)]);

  // Sanity checks: a partial or placeholder payload must never overwrite good data.
  if (!Array.isArray(boot?.elements) || boot.elements.length < 400) throw new Error(`bootstrap-static has ${boot?.elements?.length ?? 0} players, expected 400+`);
  if (!Array.isArray(boot?.teams) || boot.teams.length !== 20) throw new Error(`bootstrap-static has ${boot?.teams?.length ?? 0} teams, expected 20`);
  if (!Array.isArray(fixtures) || fixtures.length < 300) throw new Error(`fixtures has ${fixtures?.length ?? 0} matches, expected 380`);
  const firstDeadline = boot.events?.[0]?.deadline_time;
  if (!firstDeadline) throw new Error("bootstrap-static has no gameweeks");
  const y = new Date(firstDeadline).getUTCFullYear();
  const season = `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
  const stamp = now.toISOString();

  const teams = boot.teams.map((t: any) => ({ season, id: t.id, code: t.code, name: t.name, short_name: t.short_name }));
  const players = boot.elements.map((e: any) => ({
    season, id: e.id, code: e.code, team: e.team, pos: e.element_type, web_name: e.web_name, first_name: e.first_name, second_name: e.second_name,
    known_name: e.known_name || null, minutes: num(e.minutes), starts: num(e.starts), goals: num(e.goals_scored), assists: num(e.assists),
    xg: num(e.expected_goals), xa: num(e.expected_assists), saves: num(e.saves), goals_conceded: num(e.goals_conceded),
    xgc: num(e.expected_goals_conceded), clean_sheets: num(e.clean_sheets), defcon: num(e.defensive_contribution),
    recoveries: num(e.recoveries), tackles: num(e.tackles), cbi: num(e.clearances_blocks_interceptions), status: e.status, chance: e.chance_of_playing_next_round ?? null,
    news: e.news || "", news_added: e.news_added || null, removed: !!e.removed, updated_at: stamp,
  }));
  // Every player who appeared in a match is in its bonus-points list, so it doubles as the appearance record.
  const appeared = (f: any, side: "h" | "a") => {
    const bps = (f.stats ?? []).find((s: any) => s.identifier === "bps");
    return f.finished && bps ? (bps[side] ?? []).map((x: any) => x.element) : null;
  };
  const fx = fixtures.filter((f: any) => f.kickoff_time).map((f: any) => ({
    season, id: f.id, event: f.event, kickoff: f.kickoff_time, team_h: f.team_h, team_a: f.team_a,
    h_score: f.team_h_score, a_score: f.team_a_score, finished: !!f.finished, appeared_h: appeared(f, "h"), appeared_a: appeared(f, "a"),
  }));

  let events = 0;
  await sql.begin(async (tx) => {
    // Status changes: compare against what we stored last time.
    const prev = new Map<number, any>();
    for (const r of await tx`select id, status, chance, news, updated_at from fpl_players where season = ${season}`) prev.set(r.id, r);
    const evs: any[] = [];
    for (const p of players) {
      const o = prev.get(p.id);
      const added = p.news_added ? new Date(p.news_added) : null;
      if (!o) {
        // First sighting. FPL's news_added is when the current status was set, so an existing injury keeps its real start date.
        if (p.status !== "a") evs.push({ season, id: p.id, at: (added && added <= now ? added : now).toISOString(), status: p.status, chance: p.chance, news: p.news, prev_status: null });
        continue;
      }
      if (o.status === p.status && (o.chance ?? null) === (p.chance ?? null) && (o.news ?? "") === p.news) continue;
      // Prefer FPL's own timestamp when it falls between our last look and now.
      const at = added && added > new Date(o.updated_at) && added <= now ? added : now;
      evs.push({ season, id: p.id, at: at.toISOString(), status: p.status, chance: p.chance, news: p.news, prev_status: o.status });
    }
    events = evs.length;

    await tx`insert into fpl_teams ${tx(teams)} on conflict (season, id) do update set code = excluded.code, name = excluded.name, short_name = excluded.short_name`;
    for (let i = 0; i < players.length; i += 250) {
      await tx`insert into fpl_players ${tx(players.slice(i, i + 250))} on conflict (season, id) do update set
        code = excluded.code, team = excluded.team, pos = excluded.pos, web_name = excluded.web_name, first_name = excluded.first_name,
        second_name = excluded.second_name, known_name = excluded.known_name, minutes = excluded.minutes, starts = excluded.starts, goals = excluded.goals,
        saves = excluded.saves, goals_conceded = excluded.goals_conceded, xgc = excluded.xgc, clean_sheets = excluded.clean_sheets,
        defcon = excluded.defcon, recoveries = excluded.recoveries, tackles = excluded.tackles, cbi = excluded.cbi,
        assists = excluded.assists, xg = excluded.xg, xa = excluded.xa, status = excluded.status, chance = excluded.chance,
        news = excluded.news, news_added = excluded.news_added, removed = excluded.removed, updated_at = excluded.updated_at`;
    }
    for (let i = 0; i < fx.length; i += 200) {
      await tx`insert into fpl_fixtures ${tx(fx.slice(i, i + 200))} on conflict (season, id) do update set
        event = excluded.event, kickoff = excluded.kickoff, team_h = excluded.team_h, team_a = excluded.team_a, h_score = excluded.h_score,
        a_score = excluded.a_score, finished = excluded.finished, appeared_h = excluded.appeared_h, appeared_a = excluded.appeared_a`;
    }
    const day = londonDay(now);
    const snaps = players.map((p: any) => ({ season, id: p.id, day, minutes: p.minutes, goals: p.goals, assists: p.assists, xg: p.xg, xa: p.xa, status: p.status, chance: p.chance }));
    for (let i = 0; i < snaps.length; i += 250) {
      await tx`insert into fpl_snapshots ${tx(snaps.slice(i, i + 250))} on conflict (season, id, day) do update set
        minutes = excluded.minutes, goals = excluded.goals, assists = excluded.assists, xg = excluded.xg, xa = excluded.xa, status = excluded.status, chance = excluded.chance`;
    }
    if (evs.length) await tx`insert into fpl_status_events ${tx(evs)} on conflict do nothing`;
  });
  return { season, players: players.length, events };
}

try {
  const r = await run();
  await sql`insert into fpl_runs (at, ok, season, players, events, ms) values (${now.toISOString()}, true, ${r.season}, ${r.players}, ${r.events}, ${Date.now() - started})`;
  console.log(`squad poll ok: season ${r.season}, ${r.players} players, ${r.events} status changes, ${Date.now() - started} ms`);
} catch (e) {
  console.error("squad poll failed:", String(e));
  try { await sql`insert into fpl_runs (at, ok, error, ms) values (${now.toISOString()}, false, ${String(e).slice(0, 500)}, ${Date.now() - started})`; } catch {}
  process.exitCode = 1;
} finally {
  await sql.close();
}
