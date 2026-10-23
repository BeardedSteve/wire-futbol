package squad

import (
	"math"
	"reflect"
	"testing"
	"time"
)

func ts(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func ip(n int) *int { return &n }

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestPercentileUsesMidRankForTies(t *testing.T) {
	s := []float64{0, 0, 0, 1, 2, 3}
	for _, c := range []struct{ v, want float64 }{{0, 25}, {3, 100 * 5.5 / 6}, {1.5, 100 * 4.0 / 6}, {-1, 0}, {9, 100}} {
		if got := Percentile(s, c.v); !near(got, c.want) {
			t.Errorf("Percentile(%v) = %v, want %v", c.v, got, c.want)
		}
	}
}

func TestPoolMinutes(t *testing.T) {
	if PoolMinutes(0) != 90 || PoolMinutes(7) != 210 || PoolMinutes(38) != 1140 {
		t.Fatal(PoolMinutes(0), PoolMinutes(7), PoolMinutes(38))
	}
}

func P(id, team, pos int) *Player {
	return &Player{ID: id, Team: team, Pos: pos, WebName: "Test", FirstName: "T", SecondName: "Test", Status: "a"}
}

func F(id int, kickoff string, appeared []int, finished bool) Fixture {
	return Fixture{ID: id, Event: id, Kickoff: ts(kickoff), TeamH: 14, TeamA: 2, HScore: ip(1), AScore: ip(0), Finished: finished, AppearedH: appeared, AppearedA: []int{}}
}

func TestSpells(t *testing.T) {
	fx := []Fixture{F(1, "2026-09-01T15:00:00Z", []int{1}, true), F(2, "2026-09-08T15:00:00Z", []int{9}, true), F(3, "2026-09-15T15:00:00Z", []int{1}, true), F(4, "2026-09-22T15:00:00Z", []int{9}, true), F(5, "2026-09-29T15:00:00Z", nil, false)}
	ev := []Event{
		{ID: 1, At: ts("2026-09-05T10:00:00Z"), Status: "i", Chance: ip(0), News: "Hamstring injury - Unknown return date", PrevStatus: "a"},
		{ID: 1, At: ts("2026-09-12T10:00:00Z"), Status: "d", Chance: ip(75), News: "Hamstring injury - 75% chance of playing", PrevStatus: "i"},
		{ID: 1, At: ts("2026-09-18T10:00:00Z"), Status: "a", Chance: ip(100), PrevStatus: "d"},
		{ID: 1, At: ts("2026-09-20T10:00:00Z"), Status: "d", Chance: ip(50), News: "Illness - 50% chance of playing", PrevStatus: "a"},
		{ID: 2, At: ts("2026-09-01T10:00:00Z"), Status: "i", Chance: ip(0), News: "Knee injury"},
	}
	p := P(1, 14, 3)
	sp := SpellsFor(p, ev, fx, ts("2026-09-25T10:00:00Z"))
	if len(sp) != 2 {
		t.Fatalf("%d spells", len(sp))
	}
	if sp[0].Worst != "i" || sp[0].What != "Hamstring injury" || sp[0].Missed != 1 || sp[0].Played != 1 || !sp[0].End.Equal(ts("2026-09-18T10:00:00Z")) || !near(sp[0].Days, 13) {
		t.Errorf("first spell %+v", sp[0])
	}
	if sp[1].End != nil || sp[1].What != "Illness" || sp[1].Missed != 1 || sp[1].Played != 0 || !near(sp[1].Days, 5) {
		t.Errorf("second spell %+v", sp[1])
	}
}

func TestInjuryAtFirstSighting(t *testing.T) {
	ev := []Event{{ID: 7, At: ts("2026-07-23T12:01:23Z"), Status: "i", Chance: ip(0), News: "Knee injury - Unknown return date"}}
	sp := SpellsFor(P(7, 14, 3), ev, []Fixture{F(1, "2026-08-23T15:30:00Z", []int{1, 2, 3}, true)}, ts("2026-10-23T09:00:00Z"))
	if len(sp) != 1 || sp[0].End != nil || sp[0].Missed != 1 || sp[0].What != "Knee injury" {
		t.Fatalf("%+v", sp)
	}
}

func TestHasLeft(t *testing.T) {
	p := P(1, 14, 3)
	for news, want := range map[string]bool{
		"Has joined Valencia on loan for the rest of the season": true,
		"Has joined Internazionale permanently":                  true,
		"Personal reasons - Unknown return date":                 false,
	} {
		p.Status, p.News = "u", news
		if HasLeft(p) != want {
			t.Errorf("%q", news)
		}
	}
	p.Status, p.News, p.Removed = "a", "", true
	if !HasLeft(p) {
		t.Error("removed player")
	}
}

func TestInjuryWhat(t *testing.T) {
	if InjuryWhat("Hamstring injury - Unknown return date") != "Hamstring injury" || InjuryWhat("Knock - 75% chance of playing") != "Knock" || InjuryWhat("Suspended until 01 Nov") != "" {
		t.Fatal()
	}
}

func named(web, second, first, known string) *Player {
	p := P(1, 14, 3)
	p.WebName, p.SecondName, p.FirstName, p.KnownName = web, second, first, known
	return p
}

func TestNameMatching(t *testing.T) {
	cases := []struct {
		p    *Player
		text string
		want bool
	}{
		{named("Ekitiké", "Ekitiké", "Hugo", ""), "Ekitike back in training after Achilles injury", true},
		{named("A.Becker", "Ramses Becker", "Alisson", ""), "Alisson Becker ruled out", true},
		{named("Virgil", "van Dijk", "Virgil", "Virgil van Dijk"), "Van Dijk says squad is ready", true},
		{named("Virgil", "van Dijk", "Virgil", "Virgil van Dijk"), "Virgil hails Isak", true},
		{named("Isak", "Isak", "Alexander", ""), "Isaksen signs", false},
		{named("Bradley", "Bradley", "Conor", ""), "Bradley Barcola trained individually on Thursday", false},
		{named("Bradley", "Bradley", "Conor", ""), "Conor Bradley and Hugo Ekitike are progressing well", true},
		{named("Bradley", "Bradley", "Conor", ""), "Bradley is back in training", true},
		{named("Bradley", "Bradley", "Conor", ""), "Liverpool confirm Bradley will miss the trip", true},
	}
	for _, c := range cases {
		if got := NameMatcher(c.p).Match(c.text); got != c.want {
			t.Errorf("%s in %q = %v, want %v", c.p.WebName, c.text, got, c.want)
		}
	}
}

func TestPlayedByTeamAndStatusAt(t *testing.T) {
	m := PlayedByTeam([]Fixture{F(1, "2026-09-01T15:00:00Z", []int{}, true), F(2, "2026-09-08T15:00:00Z", nil, false)})
	if m[14] != 1 || m[2] != 1 {
		t.Fatal(m)
	}
	ev := []Event{{ID: 1, At: ts("2026-09-05T10:00:00Z"), Status: "i"}, {ID: 1, At: ts("2026-09-18T10:00:00Z"), Status: "a"}}
	if StatusAt(ev, ts("2026-09-01T00:00:00Z")) != "a" || StatusAt(ev, ts("2026-09-10T00:00:00Z")) != "i" || StatusAt(ev, ts("2026-09-20T00:00:00Z")) != "a" {
		t.Fatal("StatusAt")
	}
}

func TestBuild(t *testing.T) {
	teams := []Team{{ID: 14, Name: "Liverpool", ShortName: "LIV"}, {ID: 2, Name: "Other", ShortName: "OTH"}}
	fx := []Fixture{F(1, "2026-09-01T15:00:00Z", []int{1}, true), F(2, "2026-09-08T15:00:00Z", []int{1, 3}, true), F(3, "2026-09-15T15:00:00Z", []int{1}, true)}
	var players []*Player
	for i := 0; i < 10; i++ {
		p := P(100+i, 2, 2)
		p.Minutes, p.XGC, p.Defcon = 270, float64(i), i*3
		players = append(players, p)
	}
	me := P(1, 14, 2)
	me.WebName, me.Minutes, me.Defcon = "Mine", 270, 100
	sub := P(3, 14, 2)
	sub.WebName, sub.Minutes, sub.Defcon = "Sub", 30, 10
	players = append(players, me, sub)
	ev := []Event{{ID: 3, At: ts("2026-09-10T00:00:00Z"), Status: "i", Chance: ip(0), News: "Knee injury - Unknown return date", PrevStatus: "a"}}
	m := Build(players, teams, fx, ev, "LIV", ts("2026-09-20T00:00:00Z"))
	cell := func(r *Row, k string) Cell {
		for _, c := range r.Cells {
			if c.Stat.Key == k {
				return c
			}
		}
		t.Fatalf("no %s", k)
		return Cell{}
	}
	var mine, s *Row
	for _, r := range m.Rows {
		switch r.P.ID {
		case 1:
			mine = r
		case 3:
			s = r
		}
	}
	if *cell(mine, "defcon").Pct <= 95 || *cell(mine, "xgc").Pct <= 90 {
		t.Errorf("mine %v %v", *cell(mine, "defcon").Pct, *cell(mine, "xgc").Pct)
	}
	if s.Ranked || cell(s, "defcon").Pct != nil || !near(*cell(s, "defcon").Value, 30) {
		t.Errorf("sub %+v", s)
	}
	if !reflect.DeepEqual(s.Avail, []Avail{Out, Played, Injured}) {
		t.Errorf("avail %v", s.Avail)
	}
	if len(m.Pools[2]) != 11 {
		t.Errorf("pool %d", len(m.Pools[2]))
	}
	for _, x := range m.Matches {
		if x.Opp != "OTH" {
			t.Errorf("opp %s", x.Opp)
		}
	}
	if Build(players, teams, fx, ev, "ARS", time.Now()) != nil {
		t.Error("unknown team built")
	}
}
