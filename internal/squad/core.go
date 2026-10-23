// Package squad turns the Fantasy Premier League feed into the squad page: position-specific stats ranked against
// the division, availability by match, and injury spells. League matches only.
package squad

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Player is one FPL player with season totals and current status.
type Player struct {
	ID            int       `json:"id"`
	Code          int       `json:"code"`
	Team          int       `json:"team"`
	Pos           int       `json:"pos"`
	WebName       string    `json:"web_name"`
	FirstName     string    `json:"first_name"`
	SecondName    string    `json:"second_name"`
	KnownName     string    `json:"known_name,omitempty"`
	Minutes       int       `json:"minutes"`
	Starts        int       `json:"starts"`
	Goals         int       `json:"goals"`
	Assists       int       `json:"assists"`
	XG            float64   `json:"xg"`
	XA            float64   `json:"xa"`
	Saves         int       `json:"saves"`
	GoalsConceded int       `json:"goals_conceded"`
	XGC           float64   `json:"xgc"`
	CleanSheets   int       `json:"clean_sheets"`
	Defcon        int       `json:"defcon"`
	Recoveries    int       `json:"recoveries"`
	Tackles       int       `json:"tackles"`
	CBI           int       `json:"cbi"`
	Status        string    `json:"status"`
	Chance        *int      `json:"chance"`
	News          string    `json:"news"`
	NewsAdded     time.Time `json:"news_added,omitzero"`
	Removed       bool      `json:"removed,omitempty"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// Team is one Premier League club.
type Team struct {
	ID        int    `json:"id"`
	Code      int    `json:"code"`
	Name      string `json:"name"`
	ShortName string `json:"short_name"`
}

// Fixture is one league match. Appeared lists are the players who played, once the match is finished.
type Fixture struct {
	ID        int       `json:"id"`
	Event     int       `json:"event"`
	Kickoff   time.Time `json:"kickoff"`
	TeamH     int       `json:"team_h"`
	TeamA     int       `json:"team_a"`
	HScore    *int      `json:"h_score"`
	AScore    *int      `json:"a_score"`
	Finished  bool      `json:"finished"`
	AppearedH []int     `json:"appeared_h"`
	AppearedA []int     `json:"appeared_a"`
}

// Event is a change in a player's FPL status.
type Event struct {
	ID         int       `json:"id"`
	At         time.Time `json:"at"`
	Status     string    `json:"status"`
	Chance     *int      `json:"chance"`
	News       string    `json:"news"`
	PrevStatus string    `json:"prev_status,omitempty"`
}

// Stat is one column of a position's heatmap.
type Stat struct {
	Key    string
	Label  string
	Better string // "high" or "low"
	Unit   string // "p90" or "pct"
	value  func(p *Player) (float64, bool)
}

// Value computes the stat for a player.
func (s Stat) Value(p *Player) (float64, bool) { return s.value(p) }

func p90(n float64, p *Player) (float64, bool) {
	if p.Minutes <= 0 {
		return 0, false
	}
	return n / float64(p.Minutes) * 90, true
}

var (
	stGoals       = Stat{"goals", "Goals", "high", "p90", func(p *Player) (float64, bool) { return p90(float64(p.Goals), p) }}
	stXG          = Stat{"xg", "xG", "high", "p90", func(p *Player) (float64, bool) { return p90(p.XG, p) }}
	stAssists     = Stat{"assists", "Assists", "high", "p90", func(p *Player) (float64, bool) { return p90(float64(p.Assists), p) }}
	stXA          = Stat{"xa", "xA", "high", "p90", func(p *Player) (float64, bool) { return p90(p.XA, p) }}
	stFinishing   = Stat{"finishing", "Finishing", "high", "p90", func(p *Player) (float64, bool) { return p90(float64(p.Goals)-p.XG, p) }}
	stDefcon      = Stat{"defcon", "Defending", "high", "p90", func(p *Player) (float64, bool) { return p90(float64(p.Defcon), p) }}
	stRecoveries  = Stat{"recoveries", "Recoveries", "high", "p90", func(p *Player) (float64, bool) { return p90(float64(p.Recoveries), p) }}
	stXGC         = Stat{"xgc", "xG against", "low", "p90", func(p *Player) (float64, bool) { return p90(p.XGC, p) }}
	stSaves       = Stat{"saves", "Saves", "high", "p90", func(p *Player) (float64, bool) { return p90(float64(p.Saves), p) }}
	stConceded    = Stat{"conceded", "Conceded", "low", "p90", func(p *Player) (float64, bool) { return p90(float64(p.GoalsConceded), p) }}
	stPrevented   = Stat{"prevented", "Prevented", "high", "p90", func(p *Player) (float64, bool) { return p90(p.XGC-float64(p.GoalsConceded), p) }}
	stCleanSheets = Stat{"cs", "Clean sheets", "high", "pct", func(p *Player) (float64, bool) {
		if p.Starts <= 0 {
			return 0, false
		}
		return 100 * float64(p.CleanSheets) / float64(p.Starts), true
	}}
)

// Position describes one FPL position (1 goalkeeper to 4 forward).
type Position struct {
	One, Many string
	Stats     []Stat
}

// Positions are the four FPL positions and the stats shown for each.
var Positions = map[int]Position{
	1: {"goalkeeper", "Goalkeepers", []Stat{stSaves, stConceded, stXGC, stPrevented, stCleanSheets}},
	2: {"defender", "Defenders", []Stat{stDefcon, stRecoveries, stXGC, stXG, stXA}},
	3: {"midfielder", "Midfielders", []Stat{stGoals, stXG, stAssists, stXA, stDefcon}},
	4: {"forward", "Forwards", []Stat{stGoals, stXG, stAssists, stXA, stFinishing}},
}

func injured(s string) bool { return s == "i" || s == "d" }

// Cell is one stat for one player. Pct is nil when the player isn't ranked.
type Cell struct {
	Stat  Stat
	Value *float64
	Pct   *float64
}

// Spell is a continuous run flagged injured or doubtful.
type Spell struct {
	Start  time.Time
	End    *time.Time
	Worst  string
	What   string
	Days   float64
	Missed int
	Played int
}

// Avail is a player's state for one match.
type Avail string

const (
	Played    Avail = "played"
	Injured   Avail = "injured"
	Suspended Avail = "suspended"
	Out       Avail = "out"
)

// Flag is the status pill.
type Flag struct{ Tone, Text string }

// Row is one player on the squad page.
type Row struct {
	P       *Player
	Ranked  bool
	Cells   []Cell
	Flag    *Flag
	What    string
	Spells  []Spell
	Current *Spell
	Avail   []Avail
}

// PoolEntry is one ranked player at a position, for the strip plots: name, team, rounded values.
type PoolEntry struct {
	N string     `json:"n"`
	T string     `json:"t"`
	V []*float64 `json:"v"`
}

// Match is one of the club's finished league matches.
type Match struct {
	Fixture
	Opp  string
	Home bool
}

// Model is everything the squad page shows.
type Model struct {
	Team      Team
	Played    int
	Threshold float64
	Rows      []*Row
	Away      []*Player
	Matches   []Match
	Pools     map[int][]PoolEntry
}

// PlayedByTeam counts finished league matches per team. FPL's own "played" field is always zero.
func PlayedByTeam(fx []Fixture) map[int]int {
	m := map[int]int{}
	for _, f := range fx {
		if f.Finished {
			m[f.TeamH]++
			m[f.TeamA]++
		}
	}
	return m
}

// PoolMinutes is the minimum to be ranked: a third of the team's league minutes, never below one match.
func PoolMinutes(teamPlayed int) float64 { return math.Max(90, float64(teamPlayed)*90/3) }

// Percentile is the mid-rank percentile of v within sorted: ties share one rank.
func Percentile(sorted []float64, v float64) float64 {
	lo := sort.Search(len(sorted), func(i int) bool { return sorted[i] >= v-1e-9 })
	eq := lo
	for eq < len(sorted) && math.Abs(sorted[eq]-v) <= 1e-9 {
		eq++
	}
	return 100 * (float64(lo) + 0.5*float64(eq-lo)) / float64(len(sorted))
}

var leftRe = regexp.MustCompile(`(?i)\bjoined\b|\bloan\b|\bleft the club\b|\bpermanent`)

// HasLeft is true for players sold or loaned out: FPL marks them "u" with a "Has joined ..." note.
func HasLeft(p *Player) bool { return p.Removed || (p.Status == "u" && leftRe.MatchString(p.News)) }

var injuryRe = regexp.MustCompile(`(?i)injury|knock|illness|ill\b|fitness|surgery|strain|tear|fracture|concussion`)

// InjuryWhat is the FPL news headline when it describes an injury, else "".
func InjuryWhat(news string) string {
	head := strings.TrimSpace(strings.SplitN(news, " - ", 2)[0])
	if injuryRe.MatchString(head) {
		return head
	}
	return ""
}

// StatusAt is the status in force at a moment. Before the first logged change the player counts as available.
func StatusAt(evs []Event, at time.Time) string {
	s := "a"
	for _, e := range evs {
		if e.At.After(at) {
			break
		}
		s = e.Status
	}
	return s
}

func eventsFor(id int, events []Event) []Event {
	var out []Event
	for _, e := range events {
		if e.ID == id {
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out
}

func contains(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// SpellsFor builds injury spells from the status log. Missed matches use FPL's appearance lists, so a doubtful
// player who still played isn't counted as missing.
func SpellsFor(p *Player, events []Event, fx []Fixture, now time.Time) []Spell {
	evs := eventsFor(p.ID, events)
	var out []Spell
	var cur *Spell
	closeSpell := func(end *time.Time) {
		if cur == nil {
			return
		}
		e := now
		if end != nil {
			e = *end
		}
		for _, f := range fx {
			if !f.Finished || (f.TeamH != p.Team && f.TeamA != p.Team) || f.Kickoff.Before(cur.Start) || f.Kickoff.After(e) {
				continue
			}
			list := f.AppearedA
			if f.TeamH == p.Team {
				list = f.AppearedH
			}
			if list == nil {
				continue
			}
			if contains(list, p.ID) {
				cur.Played++
			} else {
				cur.Missed++
			}
		}
		cur.End = end
		if cur.What == "" {
			cur.What = "Injury"
		}
		cur.Days = math.Max(0, e.Sub(cur.Start).Hours()/24)
		out = append(out, *cur)
		cur = nil
	}
	for _, ev := range evs {
		if injured(ev.Status) {
			what := InjuryWhat(ev.News)
			if cur == nil {
				cur = &Spell{Start: ev.At, Worst: ev.Status, What: what}
			} else {
				if ev.Status == "i" {
					cur.Worst = "i"
				}
				if what != "" {
					cur.What = what
				}
			}
		} else {
			at := ev.At
			closeSpell(&at)
		}
	}
	closeSpell(nil)
	return out
}

// FlagFor is the status pill for a player, or nil when available.
func FlagFor(p *Player) *Flag {
	switch p.Status {
	case "a":
		return nil
	case "d":
		if p.Chance != nil {
			return &Flag{"warn", "Doubtful " + strconv.Itoa(*p.Chance) + "%"}
		}
		return &Flag{"warn", "Doubtful"}
	case "i":
		return &Flag{"bad", "Injured"}
	case "s":
		return &Flag{"bad", "Suspended"}
	case "n":
		return &Flag{"bad", "Not eligible"}
	}
	return &Flag{"bad", "Unavailable"}
}

func round3(v float64, ok bool) *float64 {
	if !ok {
		return nil
	}
	r := math.Round(v*1000) / 1000
	return &r
}

// Build assembles the squad page for the team with FPL short name club. It returns nil if the team isn't found.
func Build(players []*Player, teams []Team, fixtures []Fixture, events []Event, club string, now time.Time) *Model {
	var team *Team
	short := map[int]string{}
	for i := range teams {
		short[teams[i].ID] = teams[i].ShortName
		if teams[i].ShortName == club {
			team = &teams[i]
		}
	}
	if team == nil {
		return nil
	}
	played := PlayedByTeam(fixtures)
	eligible := func(p *Player) bool {
		return !p.Removed && p.Minutes > 0 && float64(p.Minutes) >= PoolMinutes(played[p.Team])
	}

	// Comparison pools: every eligible player at each position, all clubs including ours.
	sorted := map[int]map[string][]float64{}
	pools := map[int][]PoolEntry{}
	for pos := 1; pos <= 4; pos++ {
		sorted[pos] = map[string][]float64{}
		var pool []*Player
		for _, p := range players {
			if p.Pos == pos && eligible(p) {
				pool = append(pool, p)
			}
		}
		for _, st := range Positions[pos].Stats {
			var vals []float64
			for _, p := range pool {
				if v, ok := st.Value(p); ok {
					vals = append(vals, v)
				}
			}
			sort.Float64s(vals)
			sorted[pos][st.Key] = vals
		}
		entries := []PoolEntry{}
		for _, p := range pool {
			e := PoolEntry{N: p.WebName, T: short[p.Team]}
			for _, st := range Positions[pos].Stats {
				e.V = append(e.V, round3(st.Value(p)))
			}
			entries = append(entries, e)
		}
		pools[pos] = entries
	}

	var matches []Match
	for _, f := range fixtures {
		if f.Finished && (f.TeamH == team.ID || f.TeamA == team.ID) {
			home := f.TeamH == team.ID
			opp := f.TeamH
			if home {
				opp = f.TeamA
			}
			matches = append(matches, Match{Fixture: f, Home: home, Opp: short[opp]})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].Kickoff.Before(matches[j].Kickoff) })

	m := &Model{Team: *team, Played: played[team.ID], Threshold: PoolMinutes(played[team.ID]), Matches: matches, Pools: pools}
	for _, p := range players {
		if p.Team != team.ID {
			continue
		}
		if HasLeft(p) {
			m.Away = append(m.Away, p)
			continue
		}
		pos, ok := Positions[p.Pos]
		if !ok {
			continue
		}
		ranked := eligible(p)
		row := &Row{P: p, Ranked: ranked, Flag: FlagFor(p), What: InjuryWhat(p.News)}
		for _, st := range pos.Stats {
			v, ok := st.Value(p)
			c := Cell{Stat: st}
			if ok {
				c.Value = &v
				if arr := sorted[p.Pos][st.Key]; ranked && len(arr) > 0 {
					pct := Percentile(arr, v)
					if st.Better == "low" {
						pct = 100 - pct
					}
					c.Pct = &pct
				}
			}
			row.Cells = append(row.Cells, c)
		}
		evs := eventsFor(p.ID, events)
		for _, f := range matches {
			list := f.AppearedA
			if f.Home {
				list = f.AppearedH
			}
			switch s := StatusAt(evs, f.Kickoff); {
			case contains(list, p.ID):
				row.Avail = append(row.Avail, Played)
			case injured(s):
				row.Avail = append(row.Avail, Injured)
			case s == "s":
				row.Avail = append(row.Avail, Suspended)
			default:
				row.Avail = append(row.Avail, Out)
			}
		}
		row.Spells = SpellsFor(p, evs, fixtures, now)
		for i := range row.Spells {
			if row.Spells[i].End == nil {
				row.Current = &row.Spells[i]
				break
			}
		}
		m.Rows = append(m.Rows, row)
	}
	sort.SliceStable(m.Away, func(i, j int) bool { return m.Away[i].WebName < m.Away[j].WebName })
	sort.SliceStable(m.Rows, func(i, j int) bool {
		a, b := m.Rows[i].P, m.Rows[j].P
		if a.Pos != b.Pos {
			return a.Pos < b.Pos
		}
		if a.Minutes != b.Minutes {
			return a.Minutes > b.Minutes
		}
		return a.WebName < b.WebName
	})
	return m
}

// fold removes accents the way Unicode NFD plus dropping combining marks does, for the Latin letters footballers'
// names use. Letters NFD leaves alone (ø, ł, ß, æ) stay as they are.
func fold(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		if base, ok := accentBase[r]; ok {
			b.WriteRune(base)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var accentBase = func() map[rune]rune {
	pairs := []string{
		"ÀÁÂÃÄÅĀĂĄǍ", "A", "àáâãäåāăąǎ", "a", "ÇĆĈĊČ", "C", "çćĉċč", "c", "ĎḌ", "D", "ďḍ", "d",
		"ÈÉÊËĒĔĖĘĚẼ", "E", "èéêëēĕėęěẽ", "e", "ĜĞĠĢǦ", "G", "ĝğġģǧ", "g", "ĤḤ", "H", "ĥḥ", "h",
		"ÌÍÎÏĨĪĬĮİǏ", "I", "ìíîïĩīĭįǐ", "i", "Ĵ", "J", "ĵ", "j", "Ķ", "K", "ķ", "k", "ĹĻĽ", "L", "ĺļľ", "l",
		"ÑŃŅŇ", "N", "ñńņň", "n", "ÒÓÔÕÖŌŎŐƠǑ", "O", "òóôõöōŏőơǒ", "o", "ŔŖŘ", "R", "ŕŗř", "r",
		"ŚŜŞŠȘ", "S", "śŝşšș", "s", "ŢŤȚ", "T", "ţťț", "t", "ÙÚÛÜŨŪŬŮŰŲƯǓ", "U", "ùúûüũūŭůűųưǔ", "u",
		"Ŵ", "W", "ŵ", "w", "ÝŶŸ", "Y", "ýÿŷ", "y", "ŹŻŽ", "Z", "źżž", "z",
	}
	m := map[rune]rune{}
	for i := 0; i < len(pairs); i += 2 {
		base := []rune(pairs[i+1])[0]
		for _, r := range pairs[i] {
			m[r] = base
		}
	}
	return m
}()

var initialRe = regexp.MustCompile(`^[A-Z]\.\s*`)

// Matcher finds a player in story text.
type Matcher struct {
	names []string
	first string
}

// NameMatcher matches the web name without an initial, the known name, the last word of the surname and the full
// surname, ignoring accents. It returns nil when the player has no usable name.
func NameMatcher(p *Player) *Matcher {
	m := &Matcher{}
	seen := map[string]bool{}
	add := func(s string) {
		t := fold(strings.TrimSpace(initialRe.ReplaceAllString(s, "")))
		if len([]rune(t)) >= 4 && !seen[t] {
			seen[t] = true
			m.names = append(m.names, t)
		}
	}
	add(p.WebName)
	add(p.KnownName)
	if parts := strings.Fields(p.SecondName); len(parts) > 0 {
		add(parts[len(parts)-1])
	}
	add(p.SecondName)
	if len(m.names) == 0 {
		return nil
	}
	if f := strings.Fields(p.FirstName); len(f) > 0 {
		m.first = fold(f[0])
	}
	return m
}

var nextCapRe = regexp.MustCompile(`^\s+[A-Z][a-z]`)

// Match reports whether text names the player. A name must stand alone (no letter either side). A surname
// followed by another capitalised word is usually someone else's first name ("Bradley Barcola"), unless the
// player's own first name comes just before it ("Conor Bradley").
func (m *Matcher) Match(text string) bool {
	t := fold(text)
	for _, n := range m.names {
		for from := 0; ; {
			i := strings.Index(t[from:], n)
			if i < 0 {
				break
			}
			i += from
			end := i + len(n)
			from = i + 1
			if (i > 0 && isASCIILetter(t[i-1])) || (end < len(t) && isASCIILetter(t[end])) {
				continue
			}
			if m.first != "" && precededByFirst(t[:i], m.first) {
				return true
			}
			if !nextCapRe.MatchString(t[end:]) {
				return true
			}
		}
	}
	return false
}

func precededByFirst(before, first string) bool {
	trimmed := strings.TrimRightFunc(before, unicode.IsSpace)
	if len(trimmed) == len(before) || !strings.HasSuffix(trimmed, first) {
		return false
	}
	j := len(trimmed) - len(first)
	return j == 0 || !isASCIILetter(trimmed[j-1])
}

func isASCIILetter(c byte) bool { return 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' }
