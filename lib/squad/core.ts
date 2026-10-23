// ---------- squad: position-specific stats ranked against the division, availability and injury spells ----------
// Pure functions, no I/O. Data comes from the Fantasy Premier League feed via the squad poller's tables. League matches only.
export type SqPlayer = {
  id: number; team: number; pos: number; web_name: string; first_name: string; second_name: string; known_name: string | null;
  minutes: number; starts: number; goals: number; assists: number; xg: number; xa: number;
  saves: number; goals_conceded: number; xgc: number; clean_sheets: number; defcon: number; recoveries: number; tackles: number; cbi: number;
  status: string; chance: number | null; news: string; news_added: string | null; removed: boolean;
};
export type SqTeam = { id: number; name: string; short_name: string };
export type SqFixture = { id: number; event: number; kickoff: string; team_h: number; team_a: number; h_score: number | null; a_score: number | null; finished: boolean; appeared_h: number[] | null; appeared_a: number[] | null };
export type SqEvent = { id: number; at: string; status: string; chance: number | null; news: string; prev_status: string | null };

export type SqStat = { key: string; label: string; better: "high" | "low"; unit: "p90" | "pct"; value: (p: SqPlayer) => number | null };
const p90 = (n: number, p: SqPlayer) => (p.minutes > 0 ? (n / p.minutes) * 90 : null);
const S = {
  goals: { key: "goals", label: "Goals", better: "high", unit: "p90", value: (p) => p90(p.goals, p) },
  xg: { key: "xg", label: "xG", better: "high", unit: "p90", value: (p) => p90(p.xg, p) },
  assists: { key: "assists", label: "Assists", better: "high", unit: "p90", value: (p) => p90(p.assists, p) },
  xa: { key: "xa", label: "xA", better: "high", unit: "p90", value: (p) => p90(p.xa, p) },
  finishing: { key: "finishing", label: "Finishing", better: "high", unit: "p90", value: (p) => p90(p.goals - p.xg, p) },
  defcon: { key: "defcon", label: "Defending", better: "high", unit: "p90", value: (p) => p90(p.defcon, p) },
  recoveries: { key: "recoveries", label: "Recoveries", better: "high", unit: "p90", value: (p) => p90(p.recoveries, p) },
  xgc: { key: "xgc", label: "xG against", better: "low", unit: "p90", value: (p) => p90(p.xgc, p) },
  saves: { key: "saves", label: "Saves", better: "high", unit: "p90", value: (p) => p90(p.saves, p) },
  conceded: { key: "conceded", label: "Conceded", better: "low", unit: "p90", value: (p) => p90(p.goals_conceded, p) },
  prevented: { key: "prevented", label: "Prevented", better: "high", unit: "p90", value: (p) => p90(p.xgc - p.goals_conceded, p) },
  cleanSheets: { key: "cs", label: "Clean sheets", better: "high", unit: "pct", value: (p) => (p.starts > 0 ? (100 * p.clean_sheets) / p.starts : null) },
} satisfies Record<string, SqStat>;
export const SQ_POS: Record<number, { one: string; many: string; stats: SqStat[] }> = {
  1: { one: "goalkeeper", many: "Goalkeepers", stats: [S.saves, S.conceded, S.xgc, S.prevented, S.cleanSheets] },
  2: { one: "defender", many: "Defenders", stats: [S.defcon, S.recoveries, S.xgc, S.xg, S.xa] },
  3: { one: "midfielder", many: "Midfielders", stats: [S.goals, S.xg, S.assists, S.xa, S.defcon] },
  4: { one: "forward", many: "Forwards", stats: [S.goals, S.xg, S.assists, S.xa, S.finishing] },
};
const INJURY = new Set(["i", "d"]);
const DAY = 864e5;

export type Cell = { stat: SqStat; value: number | null; pct: number | null };
export type Spell = { start: string; end: string | null; worst: string; what: string; days: number; missed: number; played: number };
export type Avail = "played" | "injured" | "suspended" | "out";
export type SquadRow = {
  p: SqPlayer; ranked: boolean; cells: Cell[]; flag: { tone: "bad" | "warn"; text: string } | null; what: string;
  spells: Spell[]; current: Spell | null; avail: Avail[];
};
export type PoolEntry = { n: string; t: string; v: (number | null)[] };
export type SquadModel = {
  team: SqTeam; played: number; threshold: number; rows: SquadRow[]; away: SqPlayer[]; matches: (SqFixture & { opp: string; home: boolean })[];
  pools: Record<number, PoolEntry[]>;
};

/** Finished league matches per team. FPL's own team "played" field is always zero, so count fixtures. */
export function playedByTeam(fx: SqFixture[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const f of fx) if (f.finished) { m.set(f.team_h, (m.get(f.team_h) ?? 0) + 1); m.set(f.team_a, (m.get(f.team_a) ?? 0) + 1); }
  return m;
}

/** Minimum minutes to be ranked: a third of the minutes the player's team has played, never below one match. */
export const poolMinutes = (teamPlayed: number) => Math.max(90, (teamPlayed * 90) / 3);

/** Mid-rank percentile of v within sorted values: ties share one rank. */
export function percentile(sorted: number[], v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v - 1e-9) lo = mid + 1; else hi = mid; }
  let eq = lo; while (eq < sorted.length && Math.abs(sorted[eq] - v) <= 1e-9) eq++;
  return (100 * (lo + 0.5 * (eq - lo))) / sorted.length;
}

/** Players who have left the club (sold or loaned out) carry status "u" with a "Has joined ..." note. */
export const hasLeft = (p: SqPlayer) => p.removed || (p.status === "u" && /\bjoined\b|\bloan\b|\bleft the club\b|\bpermanent/i.test(p.news));

export function injuryWhat(news: string) {
  const head = (news || "").split(" - ")[0].trim();
  return /injury|knock|illness|ill\b|fitness|surgery|strain|tear|fracture|concussion/i.test(head) ? head : "";
}

/** Status in force at a moment, from the change log. Before the first logged change the player counts as available. */
export function statusAt(evs: SqEvent[], at: string): string {
  let s = "a";
  for (const e of evs) { if (e.at <= at) s = e.status; else break; }
  return s;
}

/**
 * Injury spells from the status log. A spell is a continuous run flagged injured ("i") or doubtful ("d").
 * Missed matches use FPL's appearance lists, so a doubtful player who still played isn't counted.
 */
export function spellsFor(p: SqPlayer, events: SqEvent[], fx: SqFixture[], now: Date): Spell[] {
  const evs = events.filter((e) => e.id === p.id).sort((a, b) => a.at.localeCompare(b.at));
  const out: Spell[] = [];
  let cur: { start: string; worst: string; what: string } | null = null;
  const close = (end: string | null) => {
    if (!cur) return;
    const s = new Date(cur.start).getTime(), e = end ? new Date(end).getTime() : now.getTime();
    let missed = 0, played = 0;
    for (const f of fx) {
      if (!f.finished || (f.team_h !== p.team && f.team_a !== p.team)) continue;
      const k = new Date(f.kickoff).getTime();
      if (k < s || k > e) continue;
      const list = f.team_h === p.team ? f.appeared_h : f.appeared_a;
      if (!list) continue;
      if (list.includes(p.id)) played++; else missed++;
    }
    out.push({ start: cur.start, end, worst: cur.worst, what: cur.what || "Injury", days: Math.max(0, (e - s) / DAY), missed, played });
    cur = null;
  };
  for (const ev of evs) {
    if (INJURY.has(ev.status)) {
      const what = injuryWhat(ev.news);
      if (!cur) cur = { start: ev.at, worst: ev.status, what };
      else { if (ev.status === "i") cur.worst = "i"; if (what) cur.what = what; }
    } else close(ev.at);
  }
  close(null);
  return out;
}

export function flagFor(p: SqPlayer): SquadRow["flag"] {
  switch (p.status) {
    case "a": return null;
    case "d": return { tone: "warn", text: p.chance != null ? `Doubtful ${p.chance}%` : "Doubtful" };
    case "i": return { tone: "bad", text: "Injured" };
    case "s": return { tone: "bad", text: "Suspended" };
    case "n": return { tone: "bad", text: "Not eligible" };
    default: return { tone: "bad", text: "Unavailable" };
  }
}

const round = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);

export function buildSquad(o: { players: SqPlayer[]; teams: SqTeam[]; fixtures: SqFixture[]; events: SqEvent[]; club: string; now: Date }): SquadModel | null {
  const team = o.teams.find((t) => t.short_name === o.club);
  if (!team) return null;
  const short = new Map(o.teams.map((t) => [t.id, t.short_name]));
  const played = playedByTeam(o.fixtures);
  const eligible = (p: SqPlayer) => !p.removed && p.minutes > 0 && p.minutes >= poolMinutes(played.get(p.team) ?? 0);

  // Comparison pools: every eligible player at each position, all clubs including ours.
  const sorted: Record<number, Record<string, number[]>> = {}, pools: SquadModel["pools"] = {};
  for (const pos of [1, 2, 3, 4]) {
    const pool = o.players.filter((p) => p.pos === pos && eligible(p));
    sorted[pos] = {};
    for (const st of SQ_POS[pos].stats) sorted[pos][st.key] = pool.map(st.value).filter((v): v is number => v != null).sort((a, b) => a - b);
    pools[pos] = pool.map((p) => ({ n: p.web_name, t: short.get(p.team) ?? "", v: SQ_POS[pos].stats.map((st) => round(st.value(p))) }));
  }

  const matches = o.fixtures.filter((f) => f.finished && (f.team_h === team.id || f.team_a === team.id)).sort((a, b) => a.kickoff.localeCompare(b.kickoff))
    .map((f) => ({ ...f, home: f.team_h === team.id, opp: short.get(f.team_h === team.id ? f.team_a : f.team_h) ?? "" }));

  const mine = o.players.filter((p) => p.team === team.id);
  const away = mine.filter(hasLeft).sort((a, b) => a.web_name.localeCompare(b.web_name));
  const rows: SquadRow[] = mine.filter((p) => !hasLeft(p)).map((p) => {
    const ranked = eligible(p);
    const cells = SQ_POS[p.pos].stats.map((st) => {
      const value = st.value(p), arr = sorted[p.pos][st.key];
      let pct = ranked && value != null && arr.length ? percentile(arr, value) : null;
      if (pct != null && st.better === "low") pct = 100 - pct;
      return { stat: st, value, pct };
    });
    const evs = o.events.filter((e) => e.id === p.id).sort((a, b) => a.at.localeCompare(b.at));
    const avail = matches.map((f): Avail => {
      const list = f.home ? f.appeared_h : f.appeared_a;
      if (list?.includes(p.id)) return "played";
      const s = statusAt(evs, f.kickoff);
      return INJURY.has(s) ? "injured" : s === "s" ? "suspended" : "out";
    });
    const spells = spellsFor(p, evs, o.fixtures, o.now);
    return { p, ranked, cells, flag: flagFor(p), what: injuryWhat(p.news), spells, current: spells.find((s) => s.end === null) ?? null, avail };
  }).sort((a, b) => a.p.pos - b.p.pos || b.p.minutes - a.p.minutes || a.p.web_name.localeCompare(b.p.web_name));
  const tp = played.get(team.id) ?? 0;
  return { team, played: tp, threshold: poolMinutes(tp), rows, away, matches, pools };
}

/** Names a story might use for a player: web name without an initial, surname, known name. Accents are ignored. */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
export function nameMatcher(p: SqPlayer): RegExp | null {
  const names = new Set<string>();
  const add = (s?: string | null) => { const t = fold((s || "").replace(/^[A-Z]\.\s*/, "").trim()); if (t.length >= 4) names.add(t); };
  add(p.web_name); add(p.known_name); add(p.second_name.split(" ").slice(-1)[0]); add(p.second_name);
  if (!names.size) return null;
  const alt = [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // A surname followed by another capitalised word is usually someone's first name ("Bradley Barcola"), unless the
  // player's own first name comes just before it ("Conor Bradley").
  const first = fold(p.first_name.split(" ")[0] || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z])(?:${first ? `${first}\\s+(?:${alt})(?![A-Za-z])|` : ""}(?:${alt})(?![A-Za-z])(?!\\s+[A-Z][a-z]))`);
}
export const textMatches = (re: RegExp, text: string) => re.test(fold(text));
