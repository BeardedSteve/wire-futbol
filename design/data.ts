// Design harness data: loads the real state.json and FPL snapshots from the test fixtures so every page shows live-shaped content.
// Nothing here ships. The Go service replaces this with its own state and Postgres reads.
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSquad, type SqEvent, type SqFixture, type SqPlayer, type SquadModel } from "../lib/squad/core.ts";

export type Item = {
  id: string; url: string; source: string; title: string; standfirst: string; published: string; fetched: string;
  status: "pending" | "kept" | "dropped"; category?: string; summary?: string; reason?: string; material?: boolean; cluster?: string; pushed?: boolean; dropKind?: string;
};
export type Fixture = { start: string; home: string; away: string; venue: string; url: string; competition?: string };
export type State = {
  items: Item[]; health: Record<string, { lastOk?: string; lastError?: string; lastCount?: number; fails: number }>;
  usage: Record<string, { in: number; out: number; calls: number }>; pushes?: Record<string, number>;
  lastRun?: string; modelError?: string; fixtures?: { fetchedAt: string; events: Fixture[] };
};

const fx = (name: string) => JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, "..", "test", "fixtures", name + ".gz"))).toString());

export const state: State = (() => {
  const s: State = process.env.LOCAL_STATE ? JSON.parse(readFileSync(process.env.LOCAL_STATE, "utf8")) : fx("state.json");
  return s;
})();

/** The demo clock. Fixtures are a snapshot, so unless told otherwise (or LIVE_CLOCK is set) "now" sits 40 minutes after the last poll. */
export function demoNow(override?: string | null): Date {
  if (override && !isNaN(+new Date(override))) return new Date(override);
  const last = state.lastRun ? new Date(state.lastRun).getTime() : Date.now();
  return process.env.LIVE_CLOCK ? new Date() : new Date(last + 40 * 60e3);
}

// ---------- squad model from the raw FPL feed (the service reads Postgres; the harness builds the same rows from the snapshot) ----------
const boot = fx("fpl-bootstrap.json"), fixtures = fx("fpl-fixtures.json");
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const CLUB = "LIV";
const teams = boot.teams.map((t: any) => ({ id: t.id, name: t.name, short_name: t.short_name }));
const players: SqPlayer[] = boot.elements.map((e: any) => ({
  id: e.id, team: e.team, pos: e.element_type, web_name: e.web_name, first_name: e.first_name, second_name: e.second_name, known_name: e.known_name || null,
  minutes: num(e.minutes), starts: num(e.starts), goals: num(e.goals_scored), assists: num(e.assists), xg: num(e.expected_goals), xa: num(e.expected_assists),
  saves: num(e.saves), goals_conceded: num(e.goals_conceded), xgc: num(e.expected_goals_conceded), clean_sheets: num(e.clean_sheets), defcon: num(e.defensive_contribution),
  recoveries: num(e.recoveries), tackles: num(e.tackles), cbi: num(e.clearances_blocks_interceptions),
  status: e.status, chance: e.chance_of_playing_next_round ?? null, news: e.news || "", news_added: e.news_added || null, removed: !!e.removed,
}));
const appeared = (f: any, side: "h" | "a") => {
  const bps = (f.stats ?? []).find((s: any) => s.identifier === "bps");
  return f.finished && bps ? (bps[side] ?? []).map((x: any) => x.element) : null;
};
const sqFixtures: SqFixture[] = fixtures.filter((f: any) => f.kickoff_time).map((f: any) => ({
  id: f.id, event: f.event, kickoff: f.kickoff_time, team_h: f.team_h, team_a: f.team_a, h_score: f.team_h_score, a_score: f.team_a_score,
  finished: !!f.finished, appeared_h: appeared(f, "h"), appeared_a: appeared(f, "a"),
}));
// The harness has one snapshot and no change log, so each current flag becomes a single event at FPL's own "news added" time.
const events: SqEvent[] = players.filter((p) => p.status !== "a" && p.news_added).map((p) => ({ id: p.id, at: p.news_added!, status: p.status, chance: p.chance, news: p.news, prev_status: null }));

export const squad: SquadModel = buildSquad({ players, teams, fixtures: sqFixtures, events, club: CLUB, now: demoNow() })!;
export const teamName = (id: number) => teams.find((t: any) => t.id === id)?.name ?? "";
const teamShort = (id: number) => teams.find((t: any) => t.id === id)?.short_name ?? "";
const ME = squad.team.id;

// ---------- league table and form, computed from finished fixtures ----------
export type Row = { id: number; short: string; p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number };
export const tableAt = (ms: number): Row[] => {
  const m = new Map<number, Row>();
  const row = (id: number) => m.get(id) ?? m.set(id, { id, short: teamShort(id), p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }).get(id)!;
  for (const t of teams) row(t.id);
  for (const f of sqFixtures) {
    if (!f.finished || f.h_score == null || f.a_score == null || new Date(f.kickoff).getTime() + 2.2 * 36e5 > ms) continue;
    const h = row(f.team_h), a = row(f.team_a);
    h.p++; a.p++; h.gf += f.h_score; h.ga += f.a_score; a.gf += f.a_score; a.ga += f.h_score;
    if (f.h_score > f.a_score) { h.w++; a.l++; h.pts += 3; } else if (f.h_score < f.a_score) { a.w++; h.l++; a.pts += 3; } else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  return [...m.values()].sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.short.localeCompare(y.short));
};
export const myId = ME;

export type Result = { kickoff: string; opp: string; home: boolean; for: number; against: number; res: "W" | "D" | "L" };
export const results: Result[] = squad.matches.map((f) => {
  const mine = f.home ? f.h_score! : f.a_score!, theirs = f.home ? f.a_score! : f.h_score!;
  return { kickoff: f.kickoff, opp: teamName(f.home ? f.team_a : f.team_h), home: f.home, for: mine, against: theirs, res: mine > theirs ? "W" : mine < theirs ? "L" : "D" };
});
