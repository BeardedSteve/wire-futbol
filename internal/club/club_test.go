package club

import "testing"

func TestResolve(t *testing.T) {
	withDefault := Resolver{Default: "lfc"}
	noDefault := Resolver{}
	cases := []struct {
		r    Resolver
		host string
		want string
	}{
		{noDefault, "lfc.wire.futbol", "lfc"},
		{noDefault, "LFC.Wire.Futbol:443", "lfc"},
		{noDefault, "lfc.wire.futbol.", "lfc"},
		{noDefault, "wire-go.up.railway.app", ""},
		{withDefault, "wire-go.up.railway.app", "lfc"},
		{withDefault, "localhost:8080", "lfc"},
		{withDefault, "ars.wire.futbol", ""}, // unknown club never falls back
		{withDefault, "wire.futbol", ""},
	}
	for _, c := range cases {
		got := ""
		if cl := c.r.Resolve(c.host); cl != nil {
			got = cl.Slug
		}
		if got != c.want {
			t.Errorf("Resolve(%q) with default %q = %q, want %q", c.host, c.r.Default, got, c.want)
		}
	}
}

func TestDisabledClubIsNotServed(t *testing.T) {
	saved := Clubs
	t.Cleanup(func() { Clubs = saved })
	Clubs = append([]Club{}, saved...)
	Clubs = append(Clubs, Club{Slug: "ars", Hosts: []string{"ars.wire.futbol"}, Enabled: false})
	if c := (Resolver{Default: "lfc"}).Resolve("ars.wire.futbol"); c != nil {
		t.Fatalf("disabled club resolved to %q", c.Slug)
	}
}

func TestConfigIsConsistent(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range Clubs {
		if seen[c.Slug] {
			t.Errorf("duplicate slug %q", c.Slug)
		}
		seen[c.Slug] = true
		if _, ok := Sources[c.Official]; !ok {
			t.Errorf("%s: official source %q is not defined", c.Slug, c.Official)
		}
		for _, k := range c.Sources {
			s, ok := Sources[k]
			if !ok {
				t.Errorf("%s: source %q is not defined", c.Slug, k)
			}
			if s.Key != k {
				t.Errorf("source %q has key %q", k, s.Key)
			}
		}
		if c.FPLTeam == "" || c.FixtureName == "" || c.Mark == "" {
			t.Errorf("%s: missing FPL team, fixture name or mark", c.Slug)
		}
		if k := c.Colours; k.Accent == "" || k.AccentText == "" || k.AccentDark == "" || k.AccentTextDark == "" {
			t.Errorf("%s: every club needs its colour and text colour for both themes", c.Slug)
		}
		if c.Sources[0] != c.Official {
			t.Errorf("%s: the club's own site is read first", c.Slug)
		}
	}
}

func TestEnable(t *testing.T) {
	saved := Clubs
	t.Cleanup(func() { Clubs = saved })
	Clubs = append([]Club{}, saved...)
	was := make([]bool, len(saved))
	for i := range Clubs {
		was[i] = saved[i].Enabled
		Clubs[i].Enabled = Clubs[i].Slug == "lfc"
	}
	if unknown := Enable([]string{" avfc", "nope"}); len(unknown) != 1 || unknown[0] != "nope" {
		t.Fatalf("unknown %v", unknown)
	}
	if BySlug("avfc") == nil || BySlug("afc") != nil {
		t.Fatal("Enable switched on the wrong clubs")
	}
	for i := range saved {
		if saved[i].Enabled != was[i] {
			t.Fatal("Enable changed the saved config")
		}
	}
}

func TestPickable(t *testing.T) {
	for host, want := range map[string]bool{"web-go-staging.up.railway.app": true, "localhost:3000": true, "lfc.wire.futbol": false, "wire.futbol.": false} {
		if got := Pickable(host); got != want {
			t.Errorf("Pickable(%q) = %v", host, got)
		}
	}
}

func TestFingerprint(t *testing.T) {
	saved := Sources
	t.Cleanup(func() { Sources = saved })
	Sources = map[string]Source{"a": {Key: "a", URL: "https://a/"}, "b": {Key: "b", URL: "https://b/"}}
	c := Club{Sources: []string{"a"}, Prompt: Prompt{Manager: "X"}}
	fp := c.Fingerprint()
	c.Prompt.Manager = "Y"
	if c.Fingerprint() != fp {
		t.Fatal("prompt changes should not need a poll")
	}
	c.Sources = []string{"a", "b"}
	added := c.Fingerprint()
	if added == fp {
		t.Fatal("added source not seen")
	}
	Sources["b"] = Source{Key: "b", URL: "https://b2/"}
	if c.Fingerprint() == added {
		t.Fatal("moved source not seen")
	}
}
