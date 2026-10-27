package club

import "time"

// Sources is every outlet the wire can read. To add one, give it a key here and list the key in each club that wants it.
var Sources = map[string]Source{
	"lfc": {
		Key: "lfc", Name: "liverpoolfc.com", Short: "Club", Kind: ClubSite,
		URL: "https://www.liverpoolfc.com/news", SiteBase: "https://www.liverpoolfc.com", TitleSuffix: " - Liverpool FC",
	},
	"sky":      {Key: "sky", Name: "Sky Sports", Short: "Sky", Kind: RSS, URL: "https://www.skysports.com/rss/11669"},
	"bbc":      {Key: "bbc", Name: "BBC Sport", Short: "BBC", Kind: RSS, URL: "https://feeds.bbci.co.uk/sport/football/teams/liverpool/rss.xml"},
	"echo":     {Key: "echo", Name: "Liverpool Echo", Short: "Echo", Kind: RSS, URL: "https://www.liverpoolecho.co.uk/all-about/liverpool-fc?service=rss"},
	"athletic": {Key: "athletic", Name: "The Athletic", Short: "Athletic", Kind: RSS, URL: "https://www.nytimes.com/athletic/rss/football/liverpool/"},
	"avfc": {
		Key: "avfc", Name: "avfc.co.uk", Short: "Club", Kind: ClubSite,
		URL: "https://www.avfc.co.uk/news", SiteBase: "https://www.avfc.co.uk",
	},
	"sky-avfc":      {Key: "sky-avfc", Name: "Sky Sports", Short: "Sky", Kind: RSS, URL: "https://www.skysports.com/rss/11677"},
	"bbc-avfc":      {Key: "bbc-avfc", Name: "BBC Sport", Short: "BBC", Kind: RSS, URL: "https://feeds.bbci.co.uk/sport/football/teams/aston-villa/rss.xml"},
	"mail":          {Key: "mail", Name: "Birmingham Mail", Short: "Mail", Kind: RSS, URL: "https://www.birminghammail.co.uk/all-about/aston-villa-fc?service=rss"},
	"athletic-avfc": {Key: "athletic-avfc", Name: "The Athletic", Short: "Athletic", Kind: RSS, URL: "https://www.nytimes.com/athletic/rss/football/aston-villa/"},
}

// Clubs is every club the wire knows about. Only enabled clubs are served or polled.
var Clubs = []Club{
	{
		Slug:        "lfc",
		Name:        "Liverpool FC",
		Short:       "Liverpool",
		Mark:        "LFC",
		Hosts:       []string{"lfc.wire.futbol"},
		Enabled:     true,
		Official:    "lfc",
		Sources:     []string{"lfc", "sky", "bbc", "echo", "athletic"},
		ReadsLine:   "liverpoolfc.com, BBC Sport, Sky Sports, The Athletic and the Liverpool Echo",
		FixturesURL: "https://www.liverpoolfc.com/matches/mens-team/fixtures",
		FixtureName: "Liverpool",
		FPLTeam:     "LIV",
		Shorts: []Channel{
			{ID: "UC9LQwHZoucFT94I2h6JOcjw", Name: "Liverpool FC"},
			{ID: "UCvS2Ys1xIehxddBNTWscLYg", Name: "Anfield Watch"},
			{ID: "UC30avO2n6knAFiH2c8e4qiw", Name: "The Redmen TV"},
			{ID: "UCc5C5dNupCMbyutNatfBujQ", Name: "The Anfield Wrap"},
		},
		Colours: Colours{
			Accent: "#C8102E", AccentText: "#B30D28", AccentWash: "#FBE9EC",
			AccentDark: "#FF4A5C", AccentTextDark: "#FF6B7A", AccentWashDark: "#3A1820",
		},
		Prompt: Prompt{
			Outlets:       "liverpoolfc.com, Sky Sports, BBC Sport, Liverpool Echo, The Athletic",
			Journalists:   "Ornstein, Pearce, the Echo's own reporting",
			Example:       "Isak and Gakpo are out of Sunday's game against Manchester City, the club confirms.",
			OutletExample: "The Echo",
			Manager:       "Iraola",
		},
	},
	{
		Slug:        "avfc",
		Name:        "Aston Villa",
		Short:       "Villa",
		Mark:        "AVFC",
		Hosts:       []string{"avfc.wire.futbol"},
		Enabled:     false,
		Official:    "avfc",
		Sources:     []string{"avfc", "sky-avfc", "bbc-avfc", "mail", "athletic-avfc"},
		ReadsLine:   "avfc.co.uk, BBC Sport, Sky Sports, The Athletic and the Birmingham Mail",
		FixtureName: "Aston Villa",
		FPLTeam:     "AVL",
		Shorts: []Channel{
			{ID: "UCICNP0mvtr0prFwGUQIABfQ", Name: "Aston Villa"},
			{ID: "UCsmMoJWRUvORmLnhOcOZpvw", Name: "Villa On Tour"},
			{ID: "UCwkyBsvF9NXXqMo_66wDBrA", Name: "UTV"},
			{ID: "UC6eF2Tld0kiKpWjud6uva0A", Name: "AVFC Vlogger"},
		},
		Colours: Colours{
			Accent: "#670E36", AccentText: "#670E36", AccentWash: "#F3E6EC",
			AccentDark: "#95BFE5", AccentTextDark: "#A9CDEE", AccentWashDark: "#1C2733",
		},
		Prompt: Prompt{
			Outlets:       "avfc.co.uk, Sky Sports, BBC Sport, Birmingham Mail, The Athletic",
			Journalists:   "Ornstein, Tanswell, the Mail's own reporting",
			Example:       "Watkins is out of Saturday's game against Arsenal with a hamstring injury, the club confirms.",
			OutletExample: "The Mail",
			Manager:       "Emery",
		},
	},
}

// DefaultTimeout applies to sources that don't set their own.
const DefaultTimeout = 20 * time.Second
