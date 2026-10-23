import { expect, test } from "bun:test";
import { percentile, spellsFor, hasLeft, nameMatcher, textMatches, poolMinutes, playedByTeam, injuryWhat, statusAt, buildSquad, type SqPlayer, type SqFixture, type SqEvent } from "./core";

test("percentile uses mid-rank for ties", () => {
  const s = [0, 0, 0, 1, 2, 3];
  expect(percentile(s, 0)).toBeCloseTo(25, 6);
  expect(percentile(s, 3)).toBeCloseTo((100 * 5.5) / 6, 6);
  expect(percentile(s, 1.5)).toBeCloseTo((100 * 4) / 6, 6);
  expect(percentile(s, -1)).toBe(0);
  expect(percentile(s, 9)).toBe(100);
});

test("pool threshold scales with the season and never drops below one match", () => {
  expect(poolMinutes(0)).toBe(90);
  expect(poolMinutes(7)).toBe(210);
  expect(poolMinutes(38)).toBe(1140);
});

const P = (o: Partial<SqPlayer>): SqPlayer => ({ id: 1, team: 14, pos: 3, web_name: "Test", first_name: "T", second_name: "Test", known_name: null, minutes: 0, starts: 0, goals: 0, assists: 0, xg: 0, xa: 0, saves: 0, goals_conceded: 0, xgc: 0, clean_sheets: 0, defcon: 0, recoveries: 0, tackles: 0, cbi: 0, status: "a", chance: null, news: "", news_added: null, removed: false, ...o });
const F = (id: number, kickoff: string, appeared: number[] | null, finished = true): SqFixture => ({ id, event: id, kickoff, team_h: 14, team_a: 2, h_score: 1, a_score: 0, finished, appeared_h: appeared, appeared_a: [] });

test("spells count days, missed matches, and treat a doubtful player who played as playing", () => {
  const fx = [F(1, "2026-09-01T15:00:00Z", [1]), F(2, "2026-09-08T15:00:00Z", [9]), F(3, "2026-09-15T15:00:00Z", [1]), F(4, "2026-09-22T15:00:00Z", [9]), F(5, "2026-09-29T15:00:00Z", null, false)];
  const ev: SqEvent[] = [
    { id: 1, at: "2026-09-05T10:00:00Z", status: "i", chance: 0, news: "Hamstring injury - Unknown return date", prev_status: "a" },
    { id: 1, at: "2026-09-12T10:00:00Z", status: "d", chance: 75, news: "Hamstring injury - 75% chance of playing", prev_status: "i" },
    { id: 1, at: "2026-09-18T10:00:00Z", status: "a", chance: 100, news: "", prev_status: "d" },
    { id: 1, at: "2026-09-20T10:00:00Z", status: "d", chance: 50, news: "Illness - 50% chance of playing", prev_status: "a" },
    { id: 2, at: "2026-09-01T10:00:00Z", status: "i", chance: 0, news: "Knee injury", prev_status: null },
  ];
  const sp = spellsFor(P({ id: 1 }), ev, fx, new Date("2026-09-25T10:00:00Z"));
  expect(sp.length).toBe(2);
  expect(sp[0]).toMatchObject({ worst: "i", what: "Hamstring injury", missed: 1, played: 1, end: "2026-09-18T10:00:00Z" });
  expect(sp[0].days).toBeCloseTo(13, 6);
  expect(sp[1]).toMatchObject({ end: null, what: "Illness", missed: 1, played: 0 });
  expect(sp[1].days).toBeCloseTo(5, 6);
});

test("an injury already in place at first sighting is a spell from its FPL start date", () => {
  const ev: SqEvent[] = [{ id: 7, at: "2026-07-23T12:01:23Z", status: "i", chance: 0, news: "Knee injury - Unknown return date", prev_status: null }];
  const fx = [F(1, "2026-08-23T15:30:00Z", [1, 2, 3])];
  const sp = spellsFor(P({ id: 7 }), ev, fx, new Date("2026-10-23T09:00:00Z"));
  expect(sp).toHaveLength(1);
  expect(sp[0]).toMatchObject({ end: null, missed: 1, what: "Knee injury" });
});

test("loans and sales are recognised as having left", () => {
  expect(hasLeft(P({ status: "u", news: "Has joined Valencia on loan for the rest of the season" }))).toBe(true);
  expect(hasLeft(P({ status: "u", news: "Has joined Internazionale permanently" }))).toBe(true);
  expect(hasLeft(P({ status: "u", news: "Personal reasons - Unknown return date" }))).toBe(false);
  expect(hasLeft(P({ status: "a", removed: true }))).toBe(true);
});

test("injury description comes from FPL news when it is about an injury", () => {
  expect(injuryWhat("Hamstring injury - Unknown return date")).toBe("Hamstring injury");
  expect(injuryWhat("Knock - 75% chance of playing")).toBe("Knock");
  expect(injuryWhat("Suspended until 01 Nov")).toBe("");
});

test("name matching handles initials, accents and surnames without matching inside words", () => {
  const ek = nameMatcher(P({ web_name: "Ekitiké", second_name: "Ekitiké", first_name: "Hugo" }))!;
  expect(textMatches(ek, "Ekitike back in training after Achilles injury")).toBe(true);
  const becker = nameMatcher(P({ web_name: "A.Becker", second_name: "Ramses Becker", first_name: "Alisson" }))!;
  expect(textMatches(becker, "Alisson Becker ruled out")).toBe(true);
  const vvd = nameMatcher(P({ web_name: "Virgil", second_name: "van Dijk", first_name: "Virgil", known_name: "Virgil van Dijk" }))!;
  expect(textMatches(vvd, "Van Dijk says squad is ready")).toBe(true); // last word of the surname still matches
  expect(textMatches(vvd, "Virgil hails Isak")).toBe(true);
  const jones = nameMatcher(P({ web_name: "Isak", second_name: "Isak", first_name: "Alexander" }))!;
  expect(textMatches(jones, "Isaksen signs")).toBe(false);
});

test("playedByTeam counts finished fixtures only", () => {
  const m = playedByTeam([F(1, "2026-09-01T15:00:00Z", []), F(2, "2026-09-08T15:00:00Z", null, false)]);
  expect(m.get(14)).toBe(1);
  expect(m.get(2)).toBe(1);
});

test("statusAt reads the change log, available before the first change", () => {
  const ev: SqEvent[] = [{ id: 1, at: "2026-09-05T10:00:00Z", status: "i", chance: 0, news: "", prev_status: "a" }, { id: 1, at: "2026-09-18T10:00:00Z", status: "a", chance: 100, news: "", prev_status: "i" }];
  expect(statusAt(ev, "2026-09-01T00:00:00Z")).toBe("a");
  expect(statusAt(ev, "2026-09-10T00:00:00Z")).toBe("i");
  expect(statusAt(ev, "2026-09-20T00:00:00Z")).toBe("a");
});

test("buildSquad ranks within position, inverts lower-is-better stats, and leaves short-minute players unranked", () => {
  const teams = [{ id: 14, name: "Liverpool", short_name: "LIV" }, { id: 2, name: "Other", short_name: "OTH" }];
  const fx = [F(1, "2026-09-01T15:00:00Z", [1]), F(2, "2026-09-08T15:00:00Z", [1, 3]), F(3, "2026-09-15T15:00:00Z", [1])];
  // threshold = max(90, 3*90/3) = 90 minutes
  const others = Array.from({ length: 10 }, (_, i) => P({ id: 100 + i, team: 2, pos: 2, web_name: "D" + i, minutes: 270, xgc: i, defcon: i * 3 }));
  const me = P({ id: 1, pos: 2, web_name: "Mine", minutes: 270, xgc: 0, defcon: 100 });
  const sub = P({ id: 3, pos: 2, web_name: "Sub", minutes: 30, defcon: 10 });
  const ev: SqEvent[] = [{ id: 3, at: "2026-09-10T00:00:00Z", status: "i", chance: 0, news: "Knee injury - Unknown return date", prev_status: "a" }];
  const m = buildSquad({ players: [...others, me, sub], teams, fixtures: fx, events: ev, club: "LIV", now: new Date("2026-09-20T00:00:00Z") })!;
  const mine = m.rows.find((r) => r.p.id === 1)!, s = m.rows.find((r) => r.p.id === 3)!;
  const cell = (r: typeof mine, k: string) => r.cells.find((c) => c.stat.key === k)!;
  expect(cell(mine, "defcon").pct!).toBeGreaterThan(95);
  expect(cell(mine, "xgc").pct!).toBeGreaterThan(90); // lowest xG against ranks best
  expect(s.ranked).toBe(false);
  expect(cell(s, "defcon").pct).toBeNull();
  expect(cell(s, "defcon").value).toBeCloseTo(30, 6);
  expect(s.avail).toEqual(["out", "played", "injured"]);
  expect(m.pools[2].length).toBe(11);
  expect(m.matches.map((x) => x.opp)).toEqual(["OTH", "OTH", "OTH"]);
});

test("a surname used as someone else's first name doesn't match", () => {
  const cb = nameMatcher(P({ web_name: "Bradley", second_name: "Bradley", first_name: "Conor" }))!;
  expect(textMatches(cb, "Bradley Barcola trained individually on Thursday")).toBe(false);
  expect(textMatches(cb, "Conor Bradley and Hugo Ekitike are progressing well")).toBe(true);
  expect(textMatches(cb, "Bradley is back in training")).toBe(true);
  expect(textMatches(cb, "Liverpool confirm Bradley will miss the trip")).toBe(true);
});
