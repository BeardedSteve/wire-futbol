package squad

import "testing"

func TestTable(t *testing.T) {
	teams := []Team{{ID: 1, Name: "Arsenal", ShortName: "ARS"}, {ID: 2, Name: "Brentford", ShortName: "BRE"}, {ID: 3, Name: "Chelsea", ShortName: "CHE"}, {ID: 4, Name: "Everton", ShortName: "EVE"}}
	m := func(h, a, hs, as int) Fixture {
		return Fixture{TeamH: h, TeamA: a, HScore: ip(hs), AScore: ip(as), Finished: true}
	}
	fx := []Fixture{
		m(1, 2, 2, 0),                         // ARS beat BRE
		m(3, 4, 1, 1),                         // CHE draw EVE
		m(2, 3, 3, 1),                         // BRE beat CHE
		m(4, 1, 0, 0),                         // EVE draw ARS
		{TeamH: 1, TeamA: 3, Finished: false}, // not played
		{TeamH: 2, TeamA: 4, HScore: ip(5), AScore: ip(0), Finished: false}, // live, not counted
	}
	tab := Table(teams, fx)
	got := ""
	for _, r := range tab {
		got += r.Team.ShortName + " "
	}
	// ARS 4 pts GD +2, BRE 3 pts GD 0, EVE 2 pts GD 0, CHE 1 pt GD -2
	if got != "ARS BRE EVE CHE " {
		t.Fatalf("order %q", got)
	}
	if a := tab[0]; a.P != 2 || a.W != 1 || a.D != 1 || a.L != 0 || a.GF != 2 || a.GA != 0 || a.Pts != 4 || a.GD() != 2 {
		t.Errorf("ARS %+v", a)
	}
	if c := tab[3]; c.P != 2 || c.L != 1 || c.GF != 2 || c.GA != 4 {
		t.Errorf("CHE %+v", c)
	}
}

func TestTableTieBreaksOnGoalsThenName(t *testing.T) {
	teams := []Team{{ID: 1, Name: "Wolves"}, {ID: 2, Name: "Burnley"}, {ID: 3, Name: "Fulham"}, {ID: 4, Name: "Leeds"}}
	fx := []Fixture{
		{TeamH: 1, TeamA: 2, HScore: ip(2), AScore: ip(2), Finished: true},
		{TeamH: 3, TeamA: 4, HScore: ip(0), AScore: ip(0), Finished: true},
	}
	got := ""
	for _, r := range Table(teams, fx) {
		got += r.Team.Name + " "
	}
	if got != "Burnley Wolves Fulham Leeds " {
		t.Fatalf("order %q", got)
	}
}
