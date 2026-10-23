package web

import (
	"bytes"
	"html/template"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/url"
	"strconv"
)

// Inline SVG icons; they inherit currentColor.
var icon = map[string]template.HTML{
	"ext":    `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6.5 9.5M11 9v4H3V5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	"bell":   `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.4L3 10.6h10l-1.2-2.2V6A3.8 3.8 0 0 0 8 2.2ZM6.5 12.4a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
	"tick":   `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.3 2.8 2.7 6.2-6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	"chev":   `<svg class="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	"search": `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
	"play":   `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.7 5.6v4.8L10.6 8z" fill="currentColor"/></svg>`,
	"up":     `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.2M3.6 7.4 8 3l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	"down":   `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9.8M3.6 8.6 8 13l4.4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	"undo":   `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 3.6 2.5 6.7l3.1 3.1M2.8 6.7h7a3.6 3.6 0 0 1 0 7.2H7.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	"checks": `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m1.2 8.6 3 2.9 5.6-6.3M7.4 10.9l.6.6 6.8-7.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	"squad":  `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 2.5 2.2 4.4l1.2 2.7 1.5-.6v7h6.2v-7l1.5.6 1.2-2.7-3.4-1.9a2.4 2.4 0 0 1-4.8 0Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
}

// favicon is the club-coloured W as an SVG data URL.
func favicon(accent string) template.URL {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="` + accent + `"/><text x="32" y="45" font-family="Georgia,serif" font-size="38" font-style="italic" font-weight="700" text-anchor="middle" fill="#fff">W</text></svg>`
	return template.URL("data:image/svg+xml," + url.PathEscape(svg))
}

func hexRGB(h string) (r, g, b uint8) {
	if len(h) == 7 && h[0] == '#' {
		v, err := strconv.ParseUint(h[1:], 16, 32)
		if err == nil {
			return uint8(v >> 16), uint8(v >> 8), uint8(v)
		}
	}
	return 200, 16, 46
}

// drawIcon renders the app icon: a white W on the club colour, 4x supersampled.
func drawIcon(size int, accent string) []byte {
	pts := [][2]float64{{0.2, 0.3}, {0.35, 0.71}, {0.5, 0.42}, {0.65, 0.71}, {0.8, 0.3}}
	for i := range pts {
		pts[i][0] += (0.5 - pts[i][1]) * 0.1
	}
	const half, ss = 0.052, 4
	dist := func(px, py float64, a, b [2]float64) float64 {
		dx, dy := b[0]-a[0], b[1]-a[1]
		t := math.Max(0, math.Min(1, ((px-a[0])*dx+(py-a[1])*dy)/(dx*dx+dy*dy)))
		return math.Hypot(px-a[0]-t*dx, py-a[1]-t*dy)
	}
	br, bg, bb := hexRGB(accent)
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			hit := 0
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px, py := (float64(x)+(float64(sx)+0.5)/ss)/float64(size), (float64(y)+(float64(sy)+0.5)/ss)/float64(size)
					for i := 0; i < 4; i++ {
						if dist(px, py, pts[i], pts[i+1]) < half {
							hit++
							break
						}
					}
				}
			}
			a := float64(hit) / (ss * ss)
			mix := func(c uint8) uint8 { return uint8(math.Round(float64(c) + (255-float64(c))*a)) }
			img.Set(x, y, color.RGBA{mix(br), mix(bg), mix(bb), 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

// onColour picks white or ink for text on a background colour, by WCAG contrast.
func onColour(bg string) string {
	r, g, b := hexRGB(bg)
	lin := func(c uint8) float64 {
		v := float64(c) / 255
		if v <= 0.04045 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	l := 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
	if (1.05)/(l+0.05) >= (l+0.05)/(0.0083+0.05) { // 0.0083 is the luminance of the ink, #14110e
		return "#fff"
	}
	return "#14110e"
}
