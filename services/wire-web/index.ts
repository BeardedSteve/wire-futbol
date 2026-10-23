// LFC wire: web front. Renders the wire, the filtered-out log and system status from state.json in the bucket,
// and the squad page from the Postgres tables the squad poller keeps.
import { S3Client, SQL } from "bun";
import webpush from "web-push";
import { deflateSync } from "node:zlib";
import {
  Avail, Cell, PoolEntry, SQ_POS, Spell, SqEvent, SqFixture, SqPlayer, SqStat, SqTeam, SquadModel, SquadRow, buildSquad, flagFor, hasLeft, injuryWhat, nameMatcher, percentile, playedByTeam, poolMinutes, spellsFor, statusAt, textMatches,
} from "../../lib/squad/core.ts";

const env = Bun.env;
const TZ = "Europe/London";

// ---------- storage ----------
const vhEndpoint = () => { // Bun's virtual-hosted mode expects the bucket in the endpoint host
  const ep = env.S3_ENDPOINT || "";
  if (env.S3_VIRTUAL_HOSTED !== "true" || !ep || !env.S3_BUCKET) return ep;
  const u = new URL(ep); if (!u.hostname.startsWith(env.S3_BUCKET + ".")) u.hostname = `${env.S3_BUCKET}.${u.hostname}`;
  return u.toString().replace(/\/$/, "");
};
const s3 = env.LOCAL_STATE ? null : new S3Client({
  accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
  bucket: env.S3_BUCKET!, endpoint: vhEndpoint(), region: env.S3_REGION || "auto",
  virtualHostedStyle: env.S3_VIRTUAL_HOSTED === "true",
});

type Item = {
  id: string; url: string; source: string; title: string; standfirst: string; published: string; fetched: string;
  status: "pending" | "kept" | "dropped"; category?: string; summary?: string; reason?: string; material?: boolean; cluster?: string; pushed?: boolean; dropKind?: string;
};
type Fixture = { start: string; home: string; away: string; venue: string; url: string; competition?: string };
type State = {
  items: Item[]; health: Record<string, { lastOk?: string; lastError?: string; lastCount?: number; fails: number }>;
  usage: Record<string, { in: number; out: number; calls: number }>; pushes?: Record<string, number>;
  lastRun?: string; modelError?: string; fixtures?: { fetchedAt: string; events: Fixture[] };
};

let cached: { at: number; state: State | null; raw: string } = { at: 0, state: null, raw: "" };
async function loadState(): Promise<State | null> {
  if (Date.now() - cached.at < 30_000) return cached.state;
  try {
    let raw: string | null;
    if (env.LOCAL_STATE) raw = await Bun.file(env.LOCAL_STATE).text();
    else { const f = s3!.file("state.json"); raw = (await f.exists()) ? await f.text() : null; }
    cached = { at: Date.now(), state: raw ? JSON.parse(raw) : null, raw: raw ?? "" };
  } catch (e) { console.error("state read failed", String(e)); cached.at = Date.now() - 20_000; } // keep last good copy, retry soon
  return cached.state;
}

// ---------- config mirrored from the poller (display only) ----------
const PRICE_IN = Number(env.PRICE_IN_PER_MTOK_USD || 0.75), PRICE_OUT = Number(env.PRICE_OUT_PER_MTOK_USD || 3.75), USD_GBP = Number(env.USD_TO_GBP || 0.75);
const MODEL = env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_PUSH = Number(env.MAX_PUSH_PER_DAY || 6);
const SOURCE_NAMES: [string, string][] = [["lfc", "liverpoolfc.com"], ["sky", "Sky Sports"], ["bbc", "BBC Sport"], ["echo", "Liverpool Echo"], ["athletic", "The Athletic"]];
const OFFICIAL = "liverpoolfc.com";

// ---------- PWA icons: drawn at startup (red square, white W), encoded as PNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b: Uint8Array) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
function drawIcon(size: number): Uint8Array {
  const W: [number, number][] = [[0.2, 0.3], [0.35, 0.71], [0.5, 0.42], [0.65, 0.71], [0.8, 0.3]].map(([x, y]) => [x + (0.5 - y) * 0.1, y]);
  const half = 0.052, SS = 4, raw = new Uint8Array(size * (size * 3 + 1));
  const dist = (px: number, py: number, [ax, ay]: number[], [bx, by]: number[]) => {
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS) / size, py = (y + (sy + 0.5) / SS) / size;
        for (let i = 0; i < 4; i++) if (dist(px, py, W[i], W[i + 1]) < half) { hit++; break; }
      }
      const a = hit / (SS * SS), o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(200 + 55 * a); raw[o + 1] = Math.round(16 + 239 * a); raw[o + 2] = Math.round(46 + 209 * a);
    }
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let off = 0; for (const p of parts) { png.set(p, off); off += p.length; } return png;
}
const PNG: Record<string, Uint8Array> = { "/apple-touch-icon.png": drawIcon(180), "/icon-192.png": drawIcon(192), "/icon-512.png": drawIcon(512) };

// ---------- web push ----------
const VAPID_PUBLIC = env.VAPID_PUBLIC_KEY || "";
const MAX_SUBS = 10;
type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; added: string; ua?: string };
async function readSubs(): Promise<Sub[]> {
  if (!s3) return [];
  const f = s3.file("subs.json");
  return (await f.exists()) ? JSON.parse(await f.text()) : [];
}
async function writeSubs(subs: Sub[]) { if (s3) await s3.write("subs.json", JSON.stringify(subs), { type: "application/json" }); }
async function sendPush(sub: Sub, payload: object): Promise<number> {
  webpush.setVapidDetails(env.VAPID_SUBJECT || "https://wire-web-production-7556.up.railway.app", VAPID_PUBLIC, env.VAPID_PRIVATE_KEY!);
  const d = webpush.generateRequestDetails(sub, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
  const r = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body as unknown as BodyInit, signal: AbortSignal.timeout(15000) });
  return r.status;
}
const validSub = (x: any): x is Sub => x && typeof x.endpoint === "string" && /^https:\/\//.test(x.endpoint) && x.endpoint.length < 1000 && typeof x.keys?.p256dh === "string" && typeof x.keys?.auth === "string";

// ---------- formatting ----------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o }).format(new Date(iso));
const hm = (iso: string) => fmt(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayKey = (iso: string) => fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
const longDate = (iso: string) => fmt(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
function dayLabel(iso: string) {
  const k = dayKey(iso), now = new Date();
  if (k === dayKey(now.toISOString())) return "Today";
  if (k === dayKey(new Date(now.getTime() - 864e5).toISOString())) return "Yesterday";
  return fmt(iso, { weekday: "long", day: "numeric", month: "long" });
}
function rel(iso: string) { // mirrored in client JS so it stays current without a reload
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)}h ago`;
  if (dayKey(iso) === dayKey(new Date().toISOString())) return hm(iso);
  if (dayKey(iso) === dayKey(new Date(Date.now() - 864e5).toISOString())) return `Yesterday ${hm(iso)}`;
  return fmt(iso, { weekday: "short", day: "numeric", month: "short" }) + " " + hm(iso);
}
const timeTag = (iso: string, cls = "") => `<time class="rel ${cls}" datetime="${esc(iso)}" title="${esc(fmt(iso, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}">${esc(rel(iso))}</time>`;
function untilText(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return s > -2.5 * 3600 ? "Live now" : "Finished";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m}m` : `in ${m} min`;
}
const pence = (u?: { in: number; out: number }) => (u ? ((u.in * PRICE_IN + u.out * PRICE_OUT) / 1e6) * USD_GBP * 100 : 0);

// ---------- categories ----------
type Group = "fitness" | "transfers" | "results" | "club";
const CATS: Record<string, { label: string; group: Group }> = {
  injury: { label: "Injury", group: "fitness" }, "team-news": { label: "Team news", group: "fitness" },
  transfer: { label: "Transfer", group: "transfers" }, contract: { label: "Contract", group: "transfers" },
  result: { label: "Result", group: "results" },
  staff: { label: "Staff", group: "club" }, business: { label: "Business", group: "club" }, regulation: { label: "Regulation", group: "club" }, other: { label: "Club", group: "club" },
};
const GROUPS: [Group | "all", string][] = [["all", "All"], ["fitness", "Fitness"], ["transfers", "Transfers"], ["results", "Results"], ["club", "Club"]];
const cat = (c?: string) => CATS[c || "other"] ?? CATS.other;

// ---------- icons (inline, inherit currentColor) ----------
const I = {
  ext: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6.5 9.5M11 9v4H3V5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  bell: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.4L3 10.6h10l-1.2-2.2V6A3.8 3.8 0 0 0 8 2.2ZM6.5 12.4a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  tick: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.3 2.8 2.7 6.2-6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chev: `<svg class="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  search: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  play: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.7 5.6v4.8L10.6 8z" fill="currentColor"/></svg>`,
  playFill: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>`,
  up: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.2M3.6 7.4 8 3l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  down: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9.8M3.6 8.6 8 13l4.4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  undo: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 3.6 2.5 6.7l3.1 3.1M2.8 6.7h7a3.6 3.6 0 0 1 0 7.2H7.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  checks: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m1.2 8.6 3 2.9 5.6-6.3M7.4 10.9l.6.6 6.8-7.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  soundOn: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 6.1v3.8h2.5L8 12.7V3.3L4.7 6.1Z" fill="currentColor"/><path d="M10.6 5.6a3.3 3.3 0 0 1 0 4.8M12.6 3.7a6 6 0 0 1 0 8.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  squad: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 2.5 2.2 4.4l1.2 2.7 1.5-.6v7h6.2v-7l1.5.6 1.2-2.7-3.4-1.9a2.4 2.4 0 0 1-4.8 0Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  soundOff: `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 6.1v3.8h2.5L8 12.7V3.3L4.7 6.1Z" fill="currentColor"/><path d="m10.6 6.1 3.8 3.8m0-3.8-3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};

// ---------- stories: one card per cluster ----------
type Story = { id: string; items: Item[]; lead: Item; latest: string; first: string; group: Group; official: boolean; material: boolean; pushed: boolean; fetched: string };
// Safety net for the model's clustering: merge clusters whose summaries say the same thing (word overlap) within 36 hours.
const STOP = new Set("a an the and or of to in on at for by with from as is are was were be been has have had will would that this it its his their they he she not but after before over into than then about against ahead up out off club confirms reports says said report".split(" "));
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
function similar(a: Item[], b: Item[]) {
  const ta = Math.max(...a.map((x) => +new Date(x.published))), tb = Math.max(...b.map((x) => +new Date(x.published)));
  if (Math.abs(ta - tb) > 36 * 36e5) return false;
  return a.some((x) => b.some((y) => {
    const A = words(x.summary || x.title), B = words(y.summary || y.title);
    let n = 0; for (const w of A) if (B.has(w)) n++;
    return n >= 4 && n / Math.min(A.size, B.size) >= 0.6;
  }));
}
function stories(state: State): Story[] {
  const by = new Map<string, Item[]>();
  for (const it of state.items) if (it.status === "kept") { const k = it.cluster || it.id; (by.get(k) ?? by.set(k, []).get(k)!).push(it); }
  const keys = [...by.keys()];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = by.get(keys[i]), b = by.get(keys[j]);
    if (a && b && similar(a, b)) { a.push(...b); by.delete(keys[j]); }
  }
  return [...by.entries()].map(([id, g]) => {
    const items = [...g].sort((a, b) => b.published.localeCompare(a.published));
    // The club's own report leads when it is close to the latest word (within 12h); otherwise the newest report leads.
    const off = items.find((x) => x.source === OFFICIAL);
    const lead = off && new Date(items[0].published).getTime() - new Date(off.published).getTime() < 12 * 36e5 ? off : items[0];
    return {
      id, items, lead, latest: items[0].published, first: items[items.length - 1].published, group: cat(lead.category).group,
      official: items.some((x) => x.source === OFFICIAL), material: items.some((x) => x.material), pushed: items.some((x) => x.pushed),
      fetched: items.reduce((m, x) => (x.fetched > m ? x.fetched : m), items[0].fetched),
    };
  }).sort((a, b) => b.latest.localeCompare(a.latest));
}

// Outlet names as the wire shows them: short, the club first.
const SHORT: Record<string, string> = { "liverpoolfc.com": "Club", "Liverpool Echo": "Echo", "The Athletic": "Athletic", "BBC Sport": "BBC", "Sky Sports": "Sky" };
const shortName = (s: string) => SHORT[s] ?? s;

function storyHtml(s: Story) {
  const c = cat(s.lead.category);
  // provenance: one link per outlet (its newest piece), the club first
  const byOutlet = new Map<string, Item>();
  for (const x of s.items) if (!byOutlet.has(x.source)) byOutlet.set(x.source, x);
  const outlets = [...byOutlet.values()].sort((a, b) => (b.source === OFFICIAL ? 1 : 0) - (a.source === OFFICIAL ? 1 : 0));
  const src = (x: Item) => x.source === OFFICIAL
    ? `<a class="src club" href="${esc(x.url)}" rel="noopener" target="_blank" title="${esc(x.title)}">${I.tick}Club</a>`
    : `<a class="src" href="${esc(x.url)}" rel="noopener" target="_blank" title="${esc(x.title)}">${esc(shortName(x.source))}</a>`;
  const timeline = s.items.length > 1
    ? `<details class="reports"><summary><span class="r-open">${s.items.length} reports</span><span class="r-close">Hide reports</span></summary><ol>${s.items.map((x) => `<li${x === s.lead ? ' class="is-lead"' : ""}><p>${esc(x.summary)}</p><div class="rep-meta"><a href="${esc(x.url)}" rel="noopener" target="_blank">${esc(x.source)}${I.ext}</a>${timeTag(x.published)}</div></li>`).join("")}</ol></details>`
    : "";
  const when = fmt(s.latest, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  return `<article class="story${s.material ? " is-material" : ""}" data-group="${s.group}" data-fetched="${esc(s.fetched)}" id="s-${esc(s.id)}">
  <div class="st"><time datetime="${esc(s.latest)}" title="${esc(when)}">${esc(hm(s.latest))}</time><span class="new-badge" hidden>New</span></div>
  <div class="sb">
    <h3 class="summary">${esc(s.lead.summary || s.lead.title)}</h3>
    <div class="meta"><span class="cat">${esc(c.label)}</span>${s.material ? `<span class="mat">${s.pushed ? `${I.bell}Alert sent` : "Major"}</span>` : ""}<span class="srcs">${outlets.map(src).join("")}</span>${timeline}</div>
  </div>
</article>`;
}

// ---------- shell ----------
const FONTS = "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..800&display=swap";
const FAVICON = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#C8102E"/><text x="32" y="45" font-family="Georgia,serif" font-size="38" font-style="italic" font-weight="700" text-anchor="middle" fill="#fff">W</text></svg>`);
const MARK = `<a class="mark" href="/" aria-label="LFC Wire, home"><span class="mark-lfc">LFC</span><span class="mark-wire">Wire</span></a>`;

function shell(o: { title: string; active: "wire" | "filtered" | "status" | "squad"; state: State | null; body: string; rail?: string; top?: string; script?: string; css?: string }) {
  const st = o.state;
  const live = liveness(st);
  const ago = st?.lastRun ? Math.max(0, Math.floor((Date.now() - new Date(st.lastRun).getTime()) / 60000)) : null;
  const short = live.stale ? "Stale" : ago == null ? "Waiting" : ago < 1 ? "Now" : ago < 60 ? `${ago} min` : `${Math.floor(ago / 60)}h`;
  return `<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="Liverpool FC news from tier 1 sources only, filtered and summarised.">
<meta name="theme-color" content="#F5F6F7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0E1215" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${FAVICON}"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="LFC Wire"><meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}">
<style>${CSS}${o.css ?? ""}</style></head><body${o.rail ? ' class="has-rail-page"' : ""}>
<a class="skip" href="#main">Skip to content</a>
<header class="bar"><div class="bar-in">
  ${MARK}
  <nav class="nav" aria-label="Sections">
    <a class="navl" href="/squad"${o.active === "squad" ? ' aria-current="page"' : ""}>${I.squad}<span>Squad</span></a>
    <a class="navl" href="/shorts" id="shorts-link">${I.play}<span>Shorts</span><span class="navl-n" id="shorts-n" hidden></span></a>
    <button type="button" class="alerts-btn" id="alerts-btn" hidden aria-haspopup="dialog" aria-expanded="false">${I.bell}<span class="alerts-label">Alerts</span></button>
    <a class="live ${live.tone}" href="/status" title="${esc(live.title)}" aria-label="Wire status: ${esc(live.stale ? "not updating" : live.label)}"${o.active === "status" ? ' aria-current="page"' : ""}><span class="pulse" aria-hidden="true"></span><span class="live-long">${esc(live.stale ? "Not updating" : live.label)}</span><span class="live-short" aria-hidden="true">${esc(short)}</span></a>
  </nav>
</div></header>
${o.top ?? ""}
<div class="wrap">
  ${live.stale && o.active !== "status" ? `<div class="banner" role="status"><span class="sdot bad" aria-hidden="true"></span><span>The wire hasn't updated since ${esc(st?.lastRun ? rel(st.lastRun) : "it started")}, so recent news may be missing. <a href="/status">See status</a></span></div>` : ""}
  <div class="layout${o.rail ? " has-rail" : ""}">
    <main id="main" tabindex="-1">${o.body}</main>
    ${o.rail ? `<aside class="rail" aria-label="Fixtures and wire status">${o.rail}</aside>` : ""}
  </div>
  <footer class="foot"><p>Reads liverpoolfc.com, BBC Sport, Sky Sports, The Athletic and the Liverpool Echo every 15 minutes. Summaries are machine-written from each outlet's headline and standfirst, so follow the link before relying on detail.</p><p class="foot-links"><a href="/squad">Squad</a><a href="/status">Status</a><a href="/filtered">What the filter kept out</a></p></footer>
</div>
<div class="sheet" id="alerts-sheet" role="dialog" aria-modal="false" aria-labelledby="sheet-h" hidden><div class="sheet-in">
  <p class="sheet-h" id="sheet-h">Phone alerts</p><div id="sheet-body"></div>
</div></div>
<div class="toast" id="toast" hidden><button type="button" id="toast-btn">New stories. Show them</button></div>
<script>${CLIENT_JS}${PUSH_JS}${o.script ?? ""}</script>
</body></html>`;
}

// items the filter has failed to process for over 30 minutes: the real signal that the model is broken
const filterBacklog = (st: State) => st.items.filter((i) => i.status === "pending" && Date.now() - new Date(i.fetched).getTime() > 30 * 60e3).length;
function liveness(st: State | null) {
  if (!st?.lastRun) return { tone: "warn", label: "Waiting", title: "No run recorded yet", stale: false, backlog: 0 };
  const age = (Date.now() - new Date(st.lastRun).getTime()) / 60000;
  const failing = SOURCE_NAMES.filter(([k]) => (st.health[k]?.fails ?? 0) > 0).length;
  const stale = age > 45;
  const backlog = filterBacklog(st);
  const tone = stale ? "bad" : failing || backlog ? "warn" : "ok";
  const label = stale ? "Stale" : `Updated ${age < 1 ? "just now" : `${Math.floor(age)} min ago`}`;
  const title = stale ? `Last update ${rel(st.lastRun)}` : failing ? `${failing} source${failing > 1 ? "s" : ""} failing` : backlog ? `${backlog} items waiting over 30 minutes for the filter` : "All sources healthy";
  return { tone, label, title, stale, backlog };
}

// ---------- fixtures ----------
const isUs = (t: string) => /^liverpool$/i.test(t);
const teamHtml = (t: string) => `<span class="${isUs(t) ? "us" : ""}">${esc(t)}</span>`;
function nextFixture(st: State | null) { return st?.fixtures?.events?.find((e) => new Date(e.start).getTime() > Date.now() - 2.5 * 3600e3); }
function fixtureStrip(st: State | null) {
  const ev = nextFixture(st);
  if (!ev) return "";
  const live = untilText(ev.start) === "Live now";
  const when = `${fmt(ev.start, { weekday: "short", day: "numeric", month: "short" })}, ${hm(ev.start)}`;
  return `<div class="fx-strip${live ? " is-live" : ""}"><a class="fx-in" href="${esc(ev.url)}" rel="noopener" target="_blank">
  <span class="fx-main"><span class="fx-teams">${teamHtml(ev.home)} <span class="v">v</span> ${teamHtml(ev.away)}</span><span class="fx-meta">${esc(when)}${ev.competition ? `, ${esc(ev.competition)}` : ""}</span></span>
  <span class="fx-until" data-kickoff="${esc(ev.start)}">${esc(untilText(ev.start))}</span>
  <span class="sr-only">Liverpool ${isUs(ev.home) ? "at home to" : "away to"} ${esc(isUs(ev.home) ? ev.away : ev.home)}</span>
</a></div>`;
}
function fixtureList(st: State | null) {
  const evs = (st?.fixtures?.events ?? []).filter((e) => new Date(e.start).getTime() > Date.now() - 2.5 * 3600e3).slice(0, 5);
  if (!evs.length) return "";
  return `<section class="rail-sec"><h2 class="rail-h">Fixtures</h2><ol class="fx-list">${evs.map((e, i) => {
    const home = isUs(e.home);
    return `<li${i === 0 ? ' class="is-next"' : ""}><a href="${esc(e.url)}" rel="noopener" target="_blank"><span class="fx-d">${esc(fmt(e.start, { weekday: "short", day: "numeric", month: "short" }))}</span><span class="fx-o">${home ? "" : '<span class="at">at </span>'}${esc(home ? e.away : e.home)}</span><span class="fx-c">${esc(e.competition ?? "")}${i === 0 ? `, <span data-kickoff="${esc(e.start)}">${esc(untilText(e.start))}</span>` : ""}</span></a></li>`;
  }).join("")}</ol></section>`;
}
function statusMini(st: State) {
  const live = liveness(st);
  const ok = SOURCE_NAMES.filter(([k]) => { const h = st.health[k]; return h && h.fails === 0 && h.lastOk; }).length;
  const kept = st.items.filter((i) => i.status === "kept").length, dropped = st.items.filter((i) => i.status === "dropped").length;
  return `<section class="rail-sec"><h2 class="rail-h">The wire</h2><dl class="mini">
  <div><dt>Sources</dt><dd><span class="sdot ${ok === SOURCE_NAMES.length ? "ok" : "warn"}" aria-hidden="true"></span>${ok} of ${SOURCE_NAMES.length} healthy</dd></div>
  <div><dt>Last read</dt><dd>${st.lastRun ? timeTag(st.lastRun) : "Not yet"}</dd></div>
  <div><dt>Filtered</dt><dd>${kept} kept, ${dropped} kept out</dd></div>
</dl><p class="rail-links"><a href="/status">Status</a><a href="/filtered">Kept out</a></p>${live.backlog ? `<p class="rail-warn">${live.backlog} items waiting for the filter.</p>` : ""}</section>`;
}

// ---------- pages ----------
function wirePage(st: State | null) {
  if (!st) return shell({ title: "LFC Wire", active: "wire", state: st, body: emptyState("Starting up", "The first run hasn't finished yet. The wire reads its sources every 15 minutes.") });
  const all = stories(st);
  const counts: Record<string, number> = { all: all.length };
  for (const s of all) counts[s.group] = (counts[s.group] ?? 0) + 1;

  const groupsPresent = GROUPS.filter(([g]) => g !== "all" && counts[g]).length;
  const chips = groupsPresent < 2 ? "" : `<div class="chips" role="toolbar" aria-label="Show stories about">${GROUPS.filter(([g]) => g === "all" || counts[g]).map(([g, l]) => `<button type="button" class="chip" data-filter="${g}" aria-pressed="${g === "all"}">${esc(l)}<span class="n">${counts[g] ?? 0}</span></button>`).join("")}</div>`;

  let list = ""; let last = "";
  for (const s of all) {
    const d = dayLabel(s.latest);
    if (d !== last) { list += `${last ? "</div></section>" : ""}<section class="day"><h2 class="day-h">${esc(d)}</h2><div class="day-list">`; last = d; }
    list += storyHtml(s);
  }
  if (last) list += "</div></section>";
  const body = `<h1 class="sr-only">Liverpool FC news</h1>
<div class="list-head">${chips}</div>
<div class="newline" id="newline" hidden></div>
<div class="feed${chips ? "" : " has-no-chips"}" id="feed">${list || emptyState("Nothing yet", "No news in the last few days. New stories appear here as they break.")}</div>
<div class="empty-filter" id="empty-filter" hidden>${emptyState("Nothing here right now", "Choose All to see every story.")}</div>`;
  const rail = `${fixtureList(st)}${statusMini(st)}`;
  return shell({ title: "LFC Wire", active: "wire", state: st, top: fixtureStrip(st), body, rail, script: `initWire(${JSON.stringify(st.lastRun ?? "")},${all.length});` });
}

const KIND_LABEL: Record<string, string> = {
  opinion: "Opinion and analysis", reaction: "Reaction, no new facts", preview: "Previews and listings", rumour: "Relayed rumour",
  feature: "History and features", promo: "Promo, tickets, FPL, video", "off-topic": "Not about Liverpool", thin: "Thin, vague or duplicate", other: "Other",
};
// Older items predate the drop_kind field: classify their free-text reason instead.
const LEGACY: [string, RegExp][] = [
  ["rumour", /rumou?r|relayed|papers|gossip|unnamed/],
  ["preview", /preview|how to watch|broadcast|\btv\b|schedule|listing|atmosphere|travel/],
  ["promo", /ticket|promo|commercial|membership|fantasy|fpl|video|gallery|podcast|quiz|kit|retail|award|stream/],
  ["thin", /duplicate|vague|empty|clickbait|generic|lacking|no news|outdated|no new|thin|live (press conference )?blog|round-?up/],
  ["reaction", /reaction|quotes|comments|social media|mailbag|talk about|musing/],
  ["off-topic", /rival|opposition|other club|not about|not liverpool|industry|international|teammate|general premier|women/],
  ["feature", /histor|nostalg|memorabilia|retro|anecdote|museum|feature|interview|former|legend|statue/],
  ["opinion", /opinion|analys|column|pundit|verdict|talking|discussion|speculat|assess|predict|rating/],
];
const bucketOf = (i: Item) => KIND_LABEL[i.dropKind ?? ""] ?? KIND_LABEL[LEGACY.find(([, re]) => re.test((i.reason || "").toLowerCase()))?.[0] ?? "other"];
const crumb = (here: string) => `<nav class="crumb" aria-label="Breadcrumb"><a href="/">Wire</a><span aria-hidden="true">/</span><span aria-current="page">${esc(here)}</span></nav>`;

function filteredPage(st: State | null) {
  if (!st) return shell({ title: "Kept out · LFC Wire", active: "filtered", state: st, body: emptyState("Nothing yet", "No run has finished.") });
  const dropped = st.items.filter((i) => i.status === "dropped").sort((a, b) => b.published.localeCompare(a.published));
  const pending = st.items.filter((i) => i.status === "pending").length;
  const total = st.items.filter((i) => i.status !== "pending").length;
  const tally = new Map<string, number>(); for (const d of dropped) tally.set(bucketOf(d), (tally.get(bucketOf(d)) ?? 0) + 1);
  const max = Math.max(1, ...tally.values());
  const bars = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<li><button type="button" class="bucket" data-bucket="${esc(k)}" aria-pressed="false"><span class="b-label">${esc(k)}</span><span class="b-bar" aria-hidden="true"><span style="width:${Math.round((n / max) * 100)}%"></span></span><span class="b-n">${n}</span></button></li>`).join("");
  let rows = ""; let last = "";
  for (const d of dropped) {
    const day = dayLabel(d.published);
    if (day !== last) { rows += `<li class="row-day">${esc(day)}</li>`; last = day; }
    rows += `<li class="row" data-bucket="${esc(bucketOf(d))}" data-text="${esc((d.title + " " + d.source + " " + (d.reason ?? "")).toLowerCase())}"><time class="row-t" datetime="${esc(d.published)}">${esc(hm(d.published))}</time><div class="row-b"><a href="${esc(d.url)}" rel="noopener" target="_blank" class="row-h">${esc(d.title)}</a><div class="row-meta"><span>${esc(shortName(d.source))}</span><span class="reason">${esc(d.reason || "No reason given")}</span></div></div></li>`;
  }
  const body = `${crumb("Kept out")}<header class="page-h"><h1>Kept out</h1><p class="lead">Everything the filter rejected in the last 14 days, and why. If something here should have made the wire, the filter is too strict.</p></header>
<dl class="kpis"><div><dt>Kept out</dt><dd>${dropped.length} <span>of ${total}</span></dd></div><div><dt>Noise removed</dt><dd>${total ? Math.round((dropped.length / total) * 100) : 0}%</dd></div>${pending ? `<div><dt>Waiting for the filter</dt><dd>${pending}</dd></div>` : ""}</dl>
<section class="sec"><h2 class="sec-h">Why things were kept out</h2><p class="sec-note">Choose a reason to show only those articles.</p><ul class="buckets">${bars}</ul></section>
<div class="search"><label class="sr-only" for="q">Search kept-out articles</label>${I.search}<input id="q" type="search" placeholder="Search kept-out articles" autocomplete="off"><span class="search-n" id="qn" aria-live="polite"></span></div>
<ul class="rows" id="rows">${rows || `<li>${emptyState("Nothing kept out", "Every article so far made the wire.")}</li>`}</ul>`;
  return shell({ title: "Kept out · LFC Wire", active: "filtered", state: st, body, script: "initFiltered();" });
}

function statusPage(st: State | null, sq: SquadData | null = null) {
  if (!st) return shell({ title: "Status · LFC Wire", active: "status", state: st, body: emptyState("No data yet", "The wire hasn't completed a run.") });
  const live = liveness(st);
  const failing = SOURCE_NAMES.filter(([k]) => (st.health[k]?.fails ?? 0) > 0);
  const headline = live.stale ? "The wire has stopped updating" : failing.length ? `${failing.length} source${failing.length > 1 ? "s" : ""} failing` : live.backlog ? "The filter is falling behind" : "Everything is working";
  const srcRows = SOURCE_NAMES.map(([k, n]) => {
    const h = st.health[k]; const ok = h && h.fails === 0 && h.lastOk;
    return `<li class="srow"><span class="sdot ${ok ? "ok" : h?.lastOk ? "bad" : "warn"}" aria-hidden="true"></span><span class="s-name">${esc(n)}</span>${ok ? "" : `<span class="s-state">${h?.lastOk ? `Failing for ${h.fails} run${h.fails > 1 ? "s" : ""}` : "Never read"}</span>`}<span class="s-last">${h?.lastOk ? timeTag(h.lastOk) : ""}</span>${!ok && h?.lastError ? `<span class="s-err">${esc(h.lastError)}</span>` : ""}</li>`;
  }).join("");
  const days = Object.keys(st.usage).sort().slice(-7);
  const today = dayKey(new Date().toISOString()).split("/").reverse().join("-");
  const t = st.usage[today] ?? { in: 0, out: 0, calls: 0 };
  const vals = days.map((d) => pence(st.usage[d]));
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const vmax = Math.max(0.01, ...vals);
  const W = 34;
  const spark = `<svg class="spark" width="${days.length * W}" height="66" viewBox="0 0 ${days.length * W} 66" role="img" aria-label="Filter cost per day for the last ${days.length} days">${days.map((d, i) => { const h = Math.max(2, (vals[i] / vmax) * 40); const lbl = new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: TZ }); return `<g><title>${esc(d)}: ${vals[i].toFixed(2)}p</title><rect x="${i * W + 6}" y="${46 - h}" width="${W - 12}" height="${h}" rx="2" class="${d === today ? "bar-today" : "bar"}"/><text x="${i * W + W / 2}" y="62" text-anchor="middle" class="spark-l">${esc(lbl)}</text></g>`; }).join("")}</svg>`;
  const pushes = st.pushes?.[today] ?? 0;
  const body = `${crumb("Status")}<header class="page-h"><h1>Status</h1><p class="lead status-${live.tone}"><span class="sdot ${live.tone}" aria-hidden="true"></span>${esc(headline)}</p></header>
<div class="grid2">
<section class="sec"><h2 class="sec-h">Sources</h2><ul class="srows">${srcRows}</ul></section>
<section class="sec"><h2 class="sec-h">Schedule and alerts</h2><dl class="facts"><dt>Last run</dt><dd>${timeTag(st.lastRun!)}</dd><dt>Reads sources</dt><dd>Every 15 minutes</dd><dt>Phone alerts</dt><dd>${pushes} of ${MAX_PUSH} today, none between 22:00 and 07:00</dd><dt>Fixtures</dt><dd>${st.fixtures ? `Refreshed ${timeTag(st.fixtures.fetchedAt)}` : "Not loaded yet"}</dd><dt>Squad data</dt><dd class="${sq?.last && !sq.last.ok ? "bad-text" : ""}">${!sq ? "Not loaded yet" : sq.last && !sq.last.ok ? `Last refresh failed: ${esc(sq.last.error ?? "unknown error")}${sq.lastOk ? `. Last good ${timeTag(sq.lastOk)}` : ""}` : sq.lastOk ? `Refreshed ${timeTag(sq.lastOk)}, every two hours` : "Not loaded yet"}</dd></dl></section>
<section class="sec"><h2 class="sec-h">Filter</h2>
  <dl class="kpis tight"><div><dt>Cost today</dt><dd>${pence(t).toFixed(2)}p</dd></div><div><dt>Daily average</dt><dd>${avg.toFixed(2)}p</dd></div></dl>
  ${days.length ? spark : ""}
  <dl class="facts"><dt>State</dt><dd class="${live.backlog ? "bad-text" : ""}">${live.backlog ? `${live.backlog} items stuck. Last error: ${esc(st.modelError ?? "none recorded")}` : st.modelError ? `Working. The last call failed (${esc(st.modelError)}) and will be retried.` : "Working"}</dd><dt>Model</dt><dd>${esc(MODEL)}, ${t.calls} call${t.calls === 1 ? "" : "s"} today</dd><dt>Tokens today</dt><dd>${t.in.toLocaleString("en-GB")} in, ${t.out.toLocaleString("en-GB")} out</dd><dt>Pricing</dt><dd>$${PRICE_IN} in, $${PRICE_OUT} out, per million tokens</dd><dt>Kept</dt><dd>${st.items.filter((i) => i.status === "kept").length} articles in the last 14 days</dd><dt>Kept out</dt><dd><a href="/filtered">${st.items.filter((i) => i.status === "dropped").length} articles</a></dd></dl>
</section>
</div>`;
  return shell({ title: "Status · LFC Wire", active: "status", state: st, body });
}

const emptyState = (h: string, p: string) => `<div class="empty"><p class="empty-h">${esc(h)}</p><p>${esc(p)}</p></div>`;

// ---------- CSS ----------
// Live wire: the time column is the spine, red means material, everything else is monochrome. One family (Archivo), widths do the work.
const CSS = `
:root{--paper:#F5F6F7;--surface:#FFFFFF;--ink:#111820;--ink-2:#3D4852;--ink-3:#5F6B76;--rule:#E1E4E8;--rule-2:#CDD2D8;--red:#C8102E;--red-text:#B30D28;--red-wash:#FBE9EC;--on-red:#FFFFFF;
--ok:#1C7A4B;--warn:#9C5B00;--bad:#C8102E;
--sans:"Archivo",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--serif:var(--sans);
--r:10px;--shadow:0 1px 2px rgb(17 24 32/.06),0 6px 20px rgb(17 24 32/.07);--bar-h:52px}
@media (prefers-color-scheme:dark){:root{--paper:#0E1215;--surface:#161B20;--ink:#E9EDF0;--ink-2:#B6BFC7;--ink-3:#8C97A1;--rule:#222A31;--rule-2:#313A43;--red:#FF4A5C;--red-text:#FF6B7A;--red-wash:#3A1820;--on-red:#0E1215;
--ok:#4FCB8B;--warn:#E8B04B;--bad:#FF4A5C;--shadow:0 1px 2px rgb(0 0 0/.4),0 8px 24px rgb(0 0 0/.35)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:400 15px/1.5 var(--sans);font-variation-settings:"wdth" 100;-webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 0}
a{color:inherit}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.i{width:1em;height:1em;flex:none;vertical-align:-.125em}
:focus-visible{outline:2px solid var(--red);outline-offset:2px;border-radius:3px}
.skip{position:absolute;left:-999px;top:8px;background:var(--ink);color:var(--paper);padding:8px 12px;border-radius:6px;z-index:50}.skip:focus{left:12px}

.bar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--paper) 88%,transparent);-webkit-backdrop-filter:saturate(1.3) blur(12px);backdrop-filter:saturate(1.3) blur(12px);border-bottom:1px solid var(--rule)}
.bar-in{max-width:1040px;margin:0 auto;height:var(--bar-h);display:flex;align-items:center;gap:14px;padding:0 max(16px,env(safe-area-inset-right)) 0 max(16px,env(safe-area-inset-left))}
.mark{display:inline-flex;align-items:stretch;text-decoration:none;margin-right:auto;height:28px;border-radius:4px;overflow:hidden;font-size:15px;line-height:28px;letter-spacing:.01em}
.mark-lfc{background:var(--red);color:var(--on-red);padding:0 7px;font-weight:800;font-variation-settings:"wdth" 125}
.mark-wire{padding:0 8px;font-weight:700;font-variation-settings:"wdth" 125;border:1.5px solid var(--ink);border-left:0;border-radius:0 4px 4px 0;line-height:25px}
.nav{display:flex;align-items:center;gap:6px}
.navl,.alerts-btn,.live{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 10px;border-radius:999px;font:500 13.5px/1 var(--sans);color:var(--ink-2);text-decoration:none;white-space:nowrap;background:none;border:0;cursor:pointer}
.navl:hover,.alerts-btn:hover,.live:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 6%,transparent)}
.navl .i,.alerts-btn .i{width:17px;height:17px}
.navl-n{font:700 11px/1 var(--sans);font-variant-numeric:tabular-nums;color:var(--on-red);background:var(--red);border-radius:999px;padding:3px 6px}.navl-n[hidden]{display:none}
.alerts-btn.on{color:var(--red-text)}.alerts-btn.on .i path{fill:currentColor}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
.live.ok .pulse{animation:pulse 2.6s infinite}.live.warn .pulse{background:var(--warn)}.live.bad .pulse{background:var(--bad)}.live.bad{color:var(--red-text)}
.live-short{display:none;font-variant-numeric:tabular-nums}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 45%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media (max-width:640px){.navl>span:not(.navl-n),.alerts-label,.live-long{display:none}.live-short{display:inline}.navl,.alerts-btn,.live{padding:0 9px;min-width:40px;justify-content:center}.bar-in{gap:6px}}

.fx-strip{border-bottom:1px solid var(--rule);background:var(--surface)}
.fx-in{max-width:1040px;margin:0 auto;display:flex;align-items:center;gap:14px;min-height:52px;padding:6px max(16px,env(safe-area-inset-right)) 6px max(16px,env(safe-area-inset-left));text-decoration:none}
.fx-main{display:grid;gap:1px;min-width:0}
.fx-teams{font:600 15.5px/1.25 var(--sans);font-variation-settings:"wdth" 108;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fx-teams .us{font-weight:800}.fx-teams .v{font-weight:400;color:var(--ink-3);margin:0 2px}
.fx-meta{font-size:13px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fx-until{margin-left:auto;flex:none;font:700 14px/1 var(--sans);font-variant-numeric:tabular-nums;font-variation-settings:"wdth" 108;color:var(--ink)}
.fx-strip.is-live{background:var(--red-wash)}.fx-strip.is-live .fx-until{color:var(--red-text)}
.fx-in:hover .fx-teams{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
@media (min-width:1000px){.has-rail-page .fx-strip{display:none}}

.wrap{max-width:1040px;margin:0 auto;padding:0 max(16px,env(safe-area-inset-right)) 40px max(16px,env(safe-area-inset-left))}
.layout{display:grid;grid-template-columns:minmax(0,1fr);gap:48px}
@media (min-width:1000px){.layout.has-rail{grid-template-columns:minmax(0,660px) 280px;justify-content:space-between}}
main:focus{outline:none}
.rail{display:none}
@media (min-width:1000px){.rail{display:flex;flex-direction:column;gap:28px;position:sticky;top:calc(var(--bar-h) + 20px);align-self:start;padding-top:20px}}
.rail-h{font:700 13px/1 var(--sans);font-variation-settings:"wdth" 112;margin:0 0 10px;color:var(--ink)}
.fx-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.fx-list a{display:grid;grid-template-columns:78px 1fr;gap:1px 10px;padding:9px 0;border-bottom:1px solid var(--rule);text-decoration:none;font-size:14px}
.fx-list a:hover .fx-o{text-decoration:underline;text-underline-offset:3px}
.fx-d{color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}.fx-o{font-weight:600}.fx-o .at{font-weight:400;color:var(--ink-3)}.fx-c{grid-column:2;font-size:12.5px;color:var(--ink-3)}
.fx-list .is-next .fx-c span{color:var(--ink);font-weight:600}
.mini{margin:0;border-top:1px solid var(--rule)}.mini div{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--rule);font-size:13.5px}.mini dt{color:var(--ink-3)}.mini dd{margin:0;display:flex;align-items:center;gap:6px;text-align:right}
.rail-links{display:flex;gap:16px;margin:10px 0 0;font-size:13.5px}.rail-links a{color:var(--ink-2);text-underline-offset:3px}.rail-links a:hover{color:var(--ink)}
.rail-warn{margin:8px 0 0;font-size:13px;color:var(--warn)}

.banner{display:flex;gap:10px;align-items:baseline;border-radius:8px;padding:12px 14px;margin:16px 0 0;font-size:14px;background:var(--red-wash);color:var(--ink)}.banner a{font-weight:600}

.list-head{position:sticky;top:var(--bar-h);z-index:10;background:var(--paper);margin:0 -16px;padding:0 16px;border-bottom:1px solid var(--rule)}
@media (min-width:1000px){.list-head{margin:0;padding:0}.chips{margin:0;padding:0}}
.chips{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:0 16px;scroll-padding:16px}.chips::-webkit-scrollbar{display:none}
.chip{appearance:none;position:relative;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 10px;font:500 14px/1 var(--sans);color:var(--ink-3);background:none;border:0;cursor:pointer;white-space:nowrap}
.chip:hover{color:var(--ink)}
.chip[aria-pressed=true]{color:var(--ink);font-weight:700}.chip[aria-pressed=true]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;background:var(--ink);border-radius:2px}
.chip .n{font-size:12px;font-weight:500;color:var(--ink-3);font-variant-numeric:tabular-nums}
.chip:first-child{padding-left:0}.chip:first-child[aria-pressed=true]::after{left:0}
.newline{font:600 13px/1 var(--sans);color:var(--red-text);padding:14px 0 0}
.newline[hidden]{display:none}

.day-h{position:sticky;top:calc(var(--bar-h) + 45px);z-index:5;margin:0;padding:14px 0 6px;background:var(--paper);font:700 13px/1 var(--sans);font-variation-settings:"wdth" 112;color:var(--ink);border-bottom:1px solid var(--rule)}
.has-no-chips .day-h{top:var(--bar-h)}
.story{position:relative;display:grid;grid-template-columns:50px minmax(0,1fr);gap:0 2px;padding:11px 0 11px;border-bottom:1px solid var(--rule)}
.st{display:flex;flex-direction:column;gap:5px;padding-top:2px}
.st time{font:600 13.5px/1.2 var(--sans);font-variant-numeric:tabular-nums;font-variation-settings:"wdth" 95;color:var(--ink-3)}
.new-badge{align-self:flex-start;font:700 10.5px/1 var(--sans);letter-spacing:.02em;color:var(--on-red);background:var(--red);border-radius:3px;padding:3px 4px}.new-badge[hidden]{display:none}
.is-material::before{content:"";position:absolute;left:-12px;top:11px;bottom:11px;width:3px;border-radius:2px;background:var(--red)}
.is-material .st time{color:var(--red-text)}
.summary{margin:0;font:500 15.5px/1.36 var(--sans);letter-spacing:-.003em;text-wrap:pretty;color:var(--ink)}
.is-material .summary{font-weight:700}
@media (min-width:720px){.summary{font-size:17px}}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;margin-top:3px;font-size:13px;color:var(--ink-3)}
.cat{color:var(--ink-3)}
.mat{display:inline-flex;align-items:center;gap:4px;color:var(--red-text);font-weight:600}.mat .i{width:13px;height:13px}
.srcs{display:inline-flex;flex-wrap:wrap;gap:0 10px}
.src{display:inline-flex;align-items:center;gap:3px;min-height:30px;color:var(--ink-2);text-decoration:none;font-weight:500}
.src:hover{color:var(--ink);text-decoration:underline;text-underline-offset:3px}
.src.club{color:var(--ink);font-weight:700}.src.club .i{width:13px;height:13px;color:var(--ok)}
.reports{flex:none}
.reports[open]{flex-basis:100%}
.reports summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;min-height:30px;color:var(--ink-3);font-weight:500;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}
.reports summary::-webkit-details-marker{display:none}.reports summary:hover{color:var(--ink)}
.r-close{display:none}.reports[open] .r-open{display:none}.reports[open] .r-close{display:inline}
.reports ol{flex-basis:100%;list-style:none;margin:6px 0 2px;padding:0 0 0 12px;border-left:2px solid var(--rule-2);display:grid;gap:12px}
.reports li p{margin:0;font-size:14.5px;line-height:1.45;color:var(--ink-2)}.reports li.is-lead p{color:var(--ink)}
.rep-meta{display:flex;align-items:center;gap:10px;margin-top:3px;font-size:12.5px;color:var(--ink-3)}
.rep-meta a{display:inline-flex;align-items:center;gap:4px;min-height:28px;color:var(--ink-2);font-weight:500;text-decoration:none}.rep-meta a:hover{text-decoration:underline;text-underline-offset:3px}.rep-meta .i{width:11px;height:11px;opacity:.6}

.crumb{display:flex;gap:8px;align-items:center;padding:18px 0 0;font-size:13.5px;color:var(--ink-3)}.crumb a{color:var(--ink-2);text-underline-offset:3px}
.page-h{margin:8px 0 22px}.page-h h1{font:800 30px/1.1 var(--sans);font-variation-settings:"wdth" 115;letter-spacing:-.01em;margin:0 0 8px}
.lead{font-size:16px;line-height:1.5;color:var(--ink-2);margin:0;max-width:62ch;display:flex;align-items:center;gap:10px}
.lead.status-ok,.lead.status-warn,.lead.status-bad{font-weight:600;color:var(--ink);font-size:17px}.lead .sdot{width:10px;height:10px}
.sec{padding:0 0 4px}.sec-h{font:700 15px/1.2 var(--sans);font-variation-settings:"wdth" 112;margin:0 0 10px;padding-bottom:8px;border-bottom:2px solid var(--ink)}
.sec-note{margin:-2px 0 8px;font-size:13px;color:var(--ink-3)}
.kpis{display:flex;flex-wrap:wrap;gap:12px 36px;margin:0 0 26px}.kpis div{display:grid;gap:2px}.kpis dt{font-size:13px;color:var(--ink-3)}
.kpis dd{margin:0;font:800 30px/1.1 var(--sans);font-variation-settings:"wdth" 112;font-variant-numeric:tabular-nums}.kpis dd span{font-size:15px;font-weight:500;color:var(--ink-3)}
.kpis.tight{margin:0 0 6px}.kpis.tight dd{font-size:24px}
.sdot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}.sdot.ok{background:var(--ok)}.sdot.warn{background:var(--warn)}.sdot.bad{background:var(--bad)}
.buckets{list-style:none;margin:0;padding:0;display:grid}
.bucket{appearance:none;width:100%;display:grid;grid-template-columns:minmax(150px,210px) 1fr 36px;gap:12px;align-items:center;background:none;border:0;border-bottom:1px solid var(--rule);padding:0 6px;margin:0 -6px;min-height:42px;font:inherit;font-size:14px;color:inherit;cursor:pointer;text-align:left;border-radius:4px}
.bucket:hover{background:color-mix(in srgb,var(--ink) 5%,transparent)}.bucket[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:transparent}.bucket[aria-pressed=true] .b-bar span{background:var(--paper)}.bucket[aria-pressed=true] .b-bar{background:color-mix(in srgb,var(--paper) 25%,transparent)}
.b-bar{height:6px;background:var(--rule);border-radius:3px;overflow:hidden}.b-bar span{display:block;height:100%;background:var(--ink-2);border-radius:3px}
.b-n{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}
@media (max-width:560px){.bucket{grid-template-columns:1fr 32px;gap:6px 10px;padding:8px 6px}.b-bar{grid-column:1/-1;grid-row:2}}
.search{position:relative;display:flex;align-items:center;margin:26px 0 4px}.search .i{position:absolute;left:12px;color:var(--ink-3)}
.search input{width:100%;font:inherit;font-size:16px;color:var(--ink);background:var(--surface);border:1px solid var(--rule-2);border-radius:8px;padding:11px 92px 11px 36px}
.search input:focus{outline:2px solid var(--red);outline-offset:0;border-color:transparent}.search-n{position:absolute;right:12px;font-size:12.5px;color:var(--ink-3)}
.rows{list-style:none;margin:0;padding:0}
.row-day{padding:18px 0 6px;font:700 13px/1 var(--sans);font-variation-settings:"wdth" 112;border-bottom:1px solid var(--rule)}
.row{display:grid;grid-template-columns:52px minmax(0,1fr);gap:0 4px;padding:10px 0;border-bottom:1px solid var(--rule)}
.row-t{font:600 13px/1.4 var(--sans);font-variant-numeric:tabular-nums;color:var(--ink-3)}
.row-h{color:var(--ink-2);text-decoration:none;font-size:15px;line-height:1.4}.row-h:hover{color:var(--ink);text-decoration:underline;text-underline-offset:3px}
.row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12.5px;color:var(--ink-3);margin-top:3px}
.reason{background:color-mix(in srgb,var(--ink) 7%,transparent);color:var(--ink-2);border-radius:4px;padding:2px 6px}
.grid2{display:grid;gap:30px}@media (min-width:860px){.grid2{grid-template-columns:1fr 1fr;gap:30px 40px;align-items:start}.grid2>:last-child{grid-column:2;grid-row:1/span 2}}
.srows{list-style:none;margin:0;padding:0}.srow{display:grid;grid-template-columns:14px 1fr auto;gap:1px 8px;align-items:center;padding:11px 0;border-bottom:1px solid var(--rule)}
.s-name{font-weight:600}.s-state{grid-column:2;font-size:13px;color:var(--ink-3)}.s-last{grid-row:1;grid-column:3;font-size:13px;color:var(--ink-3);font-variant-numeric:tabular-nums}.s-err{grid-column:2/-1;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--bad);word-break:break-word}
.facts{display:grid;grid-template-columns:auto 1fr;gap:9px 16px;margin:14px 0 0;font-size:14px}.facts dt{color:var(--ink-3)}.facts dd{margin:0;overflow-wrap:anywhere}.facts a{text-underline-offset:3px}
.bad-text{color:var(--bad)}
.spark{max-width:100%;margin:6px 0 2px;display:block}.spark-l{font:500 10.5px var(--sans);fill:var(--ink-3)}.spark .bar{fill:var(--rule-2)}.spark .bar-today{fill:var(--ink)}

.empty{padding:40px 0}.empty-h{font:700 18px/1.3 var(--sans);margin:0 0 4px}.empty p{margin:0;color:var(--ink-2)}
.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--rule);font-size:13px;color:var(--ink-3);max-width:66ch}.foot p{margin:0 0 8px}
.foot-links{display:flex;gap:18px}.foot-links a{color:var(--ink-2);text-underline-offset:3px}
@media (min-width:1000px){.has-rail-page .foot-links{display:none}}
.toast{position:fixed;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:30}
.toast button{font:700 14px/1 var(--sans);background:var(--ink);color:var(--paper);border:0;border-radius:999px;padding:14px 20px;box-shadow:var(--shadow);cursor:pointer}
.sheet{position:fixed;z-index:40;top:calc(var(--bar-h) + 8px);right:max(16px,calc((100vw - 1040px)/2 + 16px));width:min(340px,calc(100vw - 32px))}
.sheet-in{background:var(--surface);border:1px solid var(--rule-2);border-radius:12px;box-shadow:var(--shadow);padding:16px}
.sheet-h{font:700 16px/1.3 var(--sans);font-variation-settings:"wdth" 112;margin:0 0 6px}.sheet p{margin:0 0 12px;font-size:14px;color:var(--ink-2)}
.sheet ol{margin:0 0 12px;padding-left:20px;font-size:14px;color:var(--ink-2)}.sheet li{margin:4px 0}
.sheet-actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{appearance:none;font:600 14px/1 var(--sans);border-radius:8px;padding:0 14px;min-height:42px;cursor:pointer;border:1px solid var(--rule-2);background:transparent;color:var(--ink)}
.btn:hover{border-color:var(--ink-3)}.btn.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}.btn:disabled{opacity:.5;cursor:default}
.back{display:inline-flex;align-items:center;gap:4px;min-height:40px;font:500 13.5px/1 var(--sans);color:var(--ink-2);text-decoration:none}.back:hover{color:var(--ink)}.back .chev{transform:rotate(90deg)}
.chev{transition:transform .2s}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media print{.bar,.chips,.rail,.toast,.fx-strip,.reports summary{display:none}.reports ol{display:grid!important}.list-head,.day-h{position:static}}
`;

// ---------- client JS (progressive enhancement; the page works without it) ----------
const CLIENT_JS = `
var LS={get:function(k){try{return localStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
function rel(iso){var s=(Date.now()-new Date(iso).getTime())/1000,d=new Date(iso);
 var hm=d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'});
 var day=function(x){return x.toLocaleDateString('en-GB',{timeZone:'Europe/London'})};
 if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+' min ago';if(s<21600)return Math.floor(s/3600)+'h ago';
 if(day(d)===day(new Date()))return hm;if(day(d)===day(new Date(Date.now()-864e5)))return 'Yesterday '+hm;
 return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'Europe/London'})+' '+hm}
function until(iso){var s=(new Date(iso).getTime()-Date.now())/1000;if(s<=0)return s>-9000?'Live now':'Finished';
 var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?'in '+d+'d '+h+'h':h>0?'in '+h+'h '+m+'m':'in '+m+' min'}
function tick(){document.querySelectorAll('time.rel').forEach(function(t){t.textContent=rel(t.getAttribute('datetime'))});
 document.querySelectorAll('[data-kickoff]').forEach(function(t){t.textContent=until(t.getAttribute('data-kickoff'))})}
setInterval(tick,60000);
function shortsBadge(){var n=document.getElementById('shorts-n'),a=document.getElementById('shorts-link'),s={},any=false;if(!n)return;
 try{JSON.parse(LS.get('wire.shorts.seen')||'[]').forEach(function(i){s[i]=1;any=true})}catch(e){}
 if(!any)return;
 fetch('/api/shorts').then(function(r){return r.ok?r.json():[]}).then(function(l){var c=l.filter(function(v){return!s[v.id]}).length;
  if(c){n.textContent=c>99?'99+':String(c);n.hidden=false;a.setAttribute('aria-label','Shorts, '+c+' unseen')}}).catch(function(){})}
function initWire(lastRun,storyCount){
 (window.requestIdleCallback||function(f){setTimeout(f,1200)})(shortsBadge);
 var chips=[].slice.call(document.querySelectorAll('.chip')),stories=[].slice.call(document.querySelectorAll('.story'));
 function apply(g){chips.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.filter===g))});var shown=0;
  stories.forEach(function(s){var on=g==='all'||s.dataset.group===g;s.hidden=!on;if(on)shown++});
  document.querySelectorAll('.day').forEach(function(d){d.hidden=!d.querySelector('.story:not([hidden])')});
  var ef=document.getElementById('empty-filter');if(ef)ef.hidden=shown>0||!stories.length;LS.set('wire:filter',g)}
 chips.forEach(function(c){c.addEventListener('click',function(){apply(c.dataset.filter)})});
 var saved=LS.get('wire:filter');if(saved&&chips.some(function(c){return c.dataset.filter===saved}))apply(saved);
 var seen=LS.get('wire:seen'),n=0;
 if(seen){stories.forEach(function(s){if(s.dataset.fetched>seen){var b=s.querySelector('.new-badge');if(b){b.hidden=false;n++}}})}
 var nl=document.getElementById('newline');if(n&&nl){nl.textContent=n+' new since '+new Date(seen).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'});nl.hidden=false}
 var mark=function(){if(document.visibilityState==='visible')LS.set('wire:seen',new Date().toISOString())};
 setTimeout(mark,4000);document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')mark()});
 var toast=document.getElementById('toast');document.getElementById('toast-btn').addEventListener('click',function(){location.reload()});
 setInterval(function(){fetch('/api/version',{cache:'no-store'}).then(function(r){return r.json()}).then(function(v){
  if(v.lastRun&&v.lastRun!==lastRun&&v.stories>storyCount)toast.hidden=false}).catch(function(){})},120000);
}
function initFiltered(){var q=document.getElementById('q'),qn=document.getElementById('qn'),rows=[].slice.call(document.querySelectorAll('.row')),
 bs=[].slice.call(document.querySelectorAll('.bucket')),active='';
 function apply(){var t=(q.value||'').trim().toLowerCase(),n=0;rows.forEach(function(r){var on=(!t||r.dataset.text.indexOf(t)>-1)&&(!active||r.dataset.bucket===active);r.hidden=!on;if(on)n++});
  document.querySelectorAll('.row-day').forEach(function(d){var x=d.nextElementSibling,any=false;while(x&&!x.classList.contains('row-day')){if(!x.hidden)any=true;x=x.nextElementSibling}d.hidden=!any});
  qn.textContent=(t||active)?n+' match'+(n===1?'':'es'):''}
 q.addEventListener('input',apply);
 bs.forEach(function(b){b.addEventListener('click',function(){active=active===b.dataset.bucket?'':b.dataset.bucket;bs.forEach(function(x){x.setAttribute('aria-pressed',String(x.dataset.bucket===active))});apply()})})}
`;

const PUSH_JS = `
(function(){
 var btn=document.getElementById('alerts-btn'),sheet=document.getElementById('alerts-sheet'),body=document.getElementById('sheet-body');
 var ios=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 var standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 var supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 var reg=null,sub=null;
 function b64(k){var p='='.repeat((4-k.length%4)%4),s=(k+p).replace(/-/g,'+').replace(/_/g,'/'),r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a}
 function post(u,d){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}
 function setBtn(){btn.classList.toggle('on',!!sub);btn.querySelector('.alerts-label').textContent=sub?'Alerts on':'Alerts';btn.setAttribute('aria-label',sub?'Phone alerts are on':'Turn on phone alerts')}
 function open(html){body.innerHTML=html;sheet.hidden=false;btn.setAttribute('aria-expanded','true');var f=sheet.querySelector('button');if(f)f.focus()}
 function close(){sheet.hidden=true;btn.setAttribute('aria-expanded','false')}
 function render(){
  if(!supported&&ios&&!standalone)return open('<p>On iPhone, alerts only work once the wire is on your Home Screen.</p><ol><li>Tap the Share button in Safari</li><li>Choose Add to Home Screen</li><li>Open LFC Wire from your Home Screen and tap Alerts</li></ol><div class="sheet-actions"><button class="btn" data-a="close">Got it</button></div>');
  if(!supported)return open('<p>This browser does not support push notifications.</p><div class="sheet-actions"><button class="btn" data-a="close">Close</button></div>');
  if(Notification.permission==='denied')return open('<p>Notifications are blocked for this site. Allow them in your phone or browser settings, then come back here.</p><div class="sheet-actions"><button class="btn" data-a="close">Close</button></div>');
  if(sub)return open('<p>You get an alert for material news only: a key player ruled out, a signing, a contract, a manager change. At most six a day, none between 22:00 and 07:00.</p><div class="sheet-actions"><button class="btn primary" data-a="test">Send a test</button><button class="btn" data-a="off">Turn off</button></div>');
  open('<p>Get a notification on this device when material news breaks: a key player ruled out, a signing, a contract, a manager change. At most six a day, none between 22:00 and 07:00.</p><div class="sheet-actions"><button class="btn primary" data-a="on">Turn on alerts</button><button class="btn" data-a="close">Not now</button></div>')}
 function msg(t){var p=document.createElement('p');p.textContent=t;body.insertBefore(p,body.querySelector('.sheet-actions'))}
 function enable(b){b.disabled=true;Notification.requestPermission().then(function(p){
  if(p!=='granted'){render();return}
  return fetch('/api/push/key').then(function(r){return r.json()}).then(function(k){
   return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(k.key)})}).then(function(s){
   sub=s;return post('/api/push/subscribe',s.toJSON())}).then(function(){setBtn();render();msg('Alerts are on. A confirmation should arrive in a few seconds.')})
 }).catch(function(e){b.disabled=false;msg('Could not turn on alerts: '+e.message)})}
 sheet.addEventListener('click',function(e){var a=e.target.closest('button');if(!a)return;var act=a.dataset.a;
  if(act==='close')close();
  else if(act==='on')enable(a);
  else if(act==='test'){a.disabled=true;post('/api/push/test',{endpoint:sub.endpoint}).then(function(){msg('Test sent.');a.disabled=false}).catch(function(e){msg('Test failed: '+e.message);a.disabled=false})}
  else if(act==='off'){a.disabled=true;var ep=sub.endpoint;sub.unsubscribe().catch(function(){}).then(function(){return post('/api/push/unsubscribe',{endpoint:ep})}).catch(function(){}).then(function(){sub=null;setBtn();close()})}});
 btn.addEventListener('click',function(){sheet.hidden?render():close()});
 document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!sheet.hidden){close();btn.focus()}});
 document.addEventListener('click',function(e){if(!sheet.hidden&&!sheet.contains(e.target)&&!btn.contains(e.target))close()});
 if(supported){navigator.serviceWorker.register('/sw.js').then(function(r){reg=r;return r.pushManager.getSubscription()}).then(function(s){
  sub=s;if(s)post('/api/push/subscribe',s.toJSON()).catch(function(){});setBtn();btn.hidden=false}).catch(function(){})}
 else if(ios&&!standalone){btn.hidden=false}
})();
`;

const SW_JS = `
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('push',function(e){var d={};try{d=e.data.json()}catch(_){d={body:e.data?e.data.text():''}}
 e.waitUntil(self.registration.showNotification(d.title||'LFC Wire',{body:d.body||'',tag:d.tag||undefined,renotify:!!d.tag,icon:'/icon-192.png',data:{url:d.url||'/'}}))});
self.addEventListener('notificationclick',function(e){e.notification.close();var url=(e.notification.data&&e.notification.data.url)||'/';
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(ws){for(var i=0;i<ws.length;i++){var w=ws[i];if('focus' in w){if(w.navigate)w.navigate(url);return w.focus()}}return self.clients.openWindow(url)}))});
`;

const MANIFEST = JSON.stringify({
  id: "/", name: "LFC Wire", short_name: "LFC Wire", description: "Liverpool FC news from tier 1 sources only.",
  start_url: "/", scope: "/", display: "standalone", background_color: "#F5F6F7", theme_color: "#F5F6F7",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

// ---------- shorts: YouTube Shorts from LFC channels, one at a time (moved from the spool worker) ----------
// Server reads each channel's Shorts playlist feed (UUSH + channel id) and merges them. Watched ids live in the viewer's browser.
const DEFAULT_SHORTS_CHANNELS = [
  { id: "UC9LQwHZoucFT94I2h6JOcjw", name: "Liverpool FC" },
  { id: "UCvS2Ys1xIehxddBNTWscLYg", name: "Anfield Watch" },
  { id: "UC30avO2n6knAFiH2c8e4qiw", name: "The Redmen TV" },
  { id: "UCc5C5dNupCMbyutNatfBujQ", name: "The Anfield Wrap" },
  { id: "UCX1em-uaFMS02Rrk_Bowyng", name: "Fabrizio Romano" },
];
const SHORTS_CHANNELS: { id: string; name: string }[] = (() => {
  try { const x = JSON.parse(env.SHORTS_CHANNELS || "[]"); if (Array.isArray(x) && x.length && x.every((c) => typeof c?.id === "string" && typeof c?.name === "string")) return x; }
  catch { console.error("SHORTS_CHANNELS is not valid JSON, using defaults"); }
  return DEFAULT_SHORTS_CHANNELS;
})();
type Short = { id: string; title: string; channel: string; published: string };
let shortsCache: { at: number; list: Short[] } = { at: 0, list: [] };
let shortsInflight: Promise<Short[]> | null = null;
const xmlText = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").trim();
async function fetchShorts(c: { id: string; name: string }): Promise<Short[]> {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${encodeURIComponent(c.id.replace(/^UC/, ""))}`, { headers: { "user-agent": "lfc-wire/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { console.error("shorts feed", c.name, r.status); return []; }
    const xml = await r.text();
    const out: Short[] = [];
    for (const [, e] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const id = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
      const pub = e.match(/<published>([^<]+)<\/published>/)?.[1];
      if (!id || !pub || isNaN(new Date(pub).getTime())) continue;
      out.push({ id, title: xmlText(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "") || "Untitled", channel: c.name, published: new Date(pub).toISOString() });
    }
    return out;
  } catch (e) { console.error("shorts feed failed", c.name, String(e)); return []; }
}
async function loadShorts(): Promise<Short[]> {
  if (Date.now() - shortsCache.at < 5 * 60e3) return shortsCache.list;
  shortsInflight ??= (async () => {
    const seen = new Set<string>();
    const list = (await Promise.all(SHORTS_CHANNELS.map(fetchShorts))).flat()
      .filter((s) => !seen.has(s.id) && !!seen.add(s.id))
      .sort((a, b) => b.published.localeCompare(a.published));
    if (list.length) shortsCache = { at: Date.now(), list };
    else shortsCache.at = Date.now() - 4 * 60e3; // every feed failed: keep the last good list, try again in a minute
    return shortsCache.list;
  })().finally(() => { shortsInflight = null; });
  return shortsInflight;
}
const channelList = (() => { const n = SHORTS_CHANNELS.map((c) => c.name); return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n[0] ?? ""; })();
function shortsPage() {
  return `<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Shorts · LFC Wire</title><meta name="robots" content="noindex">
<meta name="theme-color" content="#F5F6F7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0E1215" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${FAVICON}"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
<link rel="preconnect" href="https://www.youtube.com"><link rel="preconnect" href="https://i.ytimg.com"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}">
<style>${CSS}${SHORTS_CSS}</style></head><body class="sh-body">
<a class="skip" href="#sh-controls">Skip to controls</a>
<header class="bar"><div class="bar-in">
  ${MARK}
  <a class="back" href="/">${I.chev}Back to the wire</a>
</div></header>
<div class="sh-meter" id="sh-meter" role="progressbar" aria-label="Shorts seen this visit" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><span id="sh-fill"></span></div>
<div class="sh-head">
  <h1 class="sh-h">Shorts <span class="sh-n" id="sh-n"></span></h1>
  <button type="button" class="sh-all" id="sh-all" disabled>${I.checks}<span>Mark all seen</span></button>
</div>
<main id="main" class="sh-stage">
  <div class="sh-player" id="sh-player" data-channels="${esc(channelList)}">
    <div class="sh-slot" id="sh-slot"><div class="sh-card sh-skel" aria-label="Loading Shorts"></div></div>
    <div class="sh-controls" id="sh-controls" role="toolbar" aria-label="Shorts controls">
      <button type="button" class="sh-btn" id="sh-undo" disabled>${I.undo}<span>Undo</span></button>
      <button type="button" class="sh-btn" id="sh-skip" disabled>${I.down}<span>Skip</span></button>
      <button type="button" class="sh-btn primary" id="sh-seen" disabled>${I.up}<span>Seen</span></button>
    </div>
    <div class="sh-toast" id="sh-toast" role="status" hidden><span id="sh-toast-t"></span></div>
  </div>
</main>
<p class="sh-keys" aria-hidden="true"><span><kbd>Up</kbd>seen</span><span><kbd>Down</kbd>skip</span><span><kbd>M</kbd>sound</span><span><kbd>Space</kbd>pause</span><span><kbd>U</kbd>undo</span></p>
<div class="sr-only" id="sh-live" aria-live="polite"></div>
<noscript><p class="sh-noscript">Shorts needs JavaScript to play videos.</p></noscript>
<script>${SHORTS_JS}</script></body></html>`;
}
const SHORTS_CSS = `
.sh-body{height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden;overscroll-behavior:none}
.sh-meter{height:3px;background:var(--rule);flex:none}.sh-meter span{display:block;height:100%;width:0;background:var(--red);transition:width .3s ease}
.sh-head{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;max-width:1120px;margin:0 auto;min-height:52px;padding:6px max(16px,env(safe-area-inset-right)) 0 max(16px,env(safe-area-inset-left));flex:none}
.sh-h{font:600 22px/1.1 var(--serif);letter-spacing:-.01em;margin:0;display:flex;align-items:baseline;gap:10px;white-space:nowrap}
.sh-n{font:500 13.5px/1 var(--sans);letter-spacing:0;color:var(--ink-3);font-variant-numeric:tabular-nums}
.sh-all{appearance:none;display:inline-flex;align-items:center;gap:6px;font:500 13.5px/1 var(--sans);color:var(--ink-2);background:transparent;border:1px solid var(--rule-2);border-radius:999px;padding:0 13px;min-height:40px;cursor:pointer;white-space:nowrap;touch-action:manipulation}
.sh-all:hover:not(:disabled){color:var(--ink);border-color:var(--ink-3)}.sh-all:disabled{opacity:.4;cursor:default}.sh-all .i{width:16px;height:16px}
.sh-stage{flex:1;min-height:0;display:flex;justify-content:center;padding:8px max(16px,env(safe-area-inset-right)) 0 max(16px,env(safe-area-inset-left))}
.sh-player{height:100%;width:100%;max-width:480px;display:flex;flex-direction:column;align-items:center;gap:10px;min-height:0}
.sh-slot{flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center}
.sh-card{position:relative;height:100%;aspect-ratio:9/16;max-width:100%;background:#000;border-radius:16px;overflow:hidden;box-shadow:var(--shadow);outline:1px solid var(--rule);outline-offset:-1px;isolation:isolate;transition:transform .22s cubic-bezier(.4,0,.2,1),opacity .22s;touch-action:none;user-select:none;-webkit-user-select:none}
.sh-skel{background:var(--rule);box-shadow:none;animation:shPulse 1.4s ease-in-out infinite}@keyframes shPulse{50%{opacity:.5}}
.sh-in-up{animation:shInUp .26s ease-out both}.sh-in-down{animation:shInDown .26s ease-out both}
@keyframes shInUp{from{transform:translateY(28px);opacity:0}to{transform:none;opacity:1}}@keyframes shInDown{from{transform:translateY(-28px);opacity:0}to{transform:none;opacity:1}}
.sh-poster{position:absolute;inset:-24px;width:calc(100% + 48px);height:calc(100% + 48px);object-fit:cover;filter:blur(20px) brightness(.65);z-index:0}
.sh-card iframe{position:absolute;inset:0;width:100%;height:100%;border:0;z-index:1}
.sh-pad{position:absolute;inset:0;z-index:2;cursor:grab}.sh-pad:active{cursor:grabbing}
.sh-cue{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;display:flex;align-items:center;gap:6px;font:600 15px/1 var(--sans);color:#fff;background:rgb(0 0 0/.6);padding:11px 16px;border-radius:999px;opacity:0;pointer-events:none}
.sh-cue .i{width:17px;height:17px}
.sh-flash{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;font:600 14px/1 var(--sans);color:#fff;background:rgb(0 0 0/.6);padding:10px 14px;border-radius:999px;opacity:0;pointer-events:none}
.sh-flash.show{animation:shFlash 1.1s ease both}@keyframes shFlash{0%{opacity:0}12%{opacity:1}70%{opacity:1}100%{opacity:0}}
.sh-pz{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;width:64px;height:64px;border-radius:50%;background:rgb(0 0 0/.5);color:#fff;display:none;place-items:center;pointer-events:none}.sh-pz .i{width:26px;height:26px;margin-left:3px}
.sh-card.is-paused .sh-pz{display:grid}
.sh-mute{position:absolute;top:10px;right:10px;z-index:4;width:44px;height:44px;border-radius:50%;border:0;background:rgb(0 0 0/.5);color:#fff;display:grid;place-items:center;cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);touch-action:manipulation}
.sh-mute .i{width:20px;height:20px}.sh-mute:focus-visible{outline:2px solid #fff;outline-offset:2px}
.sh-cap{position:absolute;left:0;right:0;bottom:0;z-index:3;padding:56px 14px 14px;background:linear-gradient(to top,rgb(0 0 0/.78) 0%,rgb(0 0 0/.45) 55%,transparent);color:#fff;pointer-events:none}
.sh-t{margin:0;font:600 15px/1.35 var(--sans);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.sh-m{margin:6px 0 0;display:flex;align-items:center;gap:8px;font:500 12.5px/1.3 var(--sans);color:rgb(255 255 255/.82)}.sh-m>span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-yt{pointer-events:auto;margin-left:auto;display:inline-flex;align-items:center;gap:4px;color:#fff;text-decoration:none;padding:8px 2px;margin-top:-8px;margin-bottom:-8px;opacity:.9}.sh-yt:hover{opacity:1;text-decoration:underline;text-underline-offset:3px}.sh-yt .i{width:.9em;height:.9em}
.sh-yt:focus-visible{outline:2px solid #fff}
.sh-prog{position:absolute;left:0;right:0;bottom:0;height:3px;z-index:4;background:rgb(255 255 255/.18)}.sh-prog span{display:block;height:100%;width:0;background:#fff;transition:width .25s linear}
.sh-controls{flex:none;display:grid;grid-template-columns:auto 1fr 1.35fr;gap:8px;width:100%;max-width:380px;padding-bottom:max(12px,env(safe-area-inset-bottom))}
.sh-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:50px;padding:0 16px;border-radius:12px;border:1px solid var(--rule-2);background:var(--surface);color:var(--ink);font:600 15px/1 var(--sans);cursor:pointer;touch-action:manipulation;transition:border-color .15s,transform .08s}
.sh-btn:hover:not(:disabled){border-color:var(--ink-3)}.sh-btn:active:not(:disabled){transform:scale(.97)}.sh-btn:disabled{opacity:.38;cursor:default}
.sh-btn.primary{background:var(--red);border-color:var(--red);color:var(--on-red)}.sh-btn.primary:hover:not(:disabled){border-color:var(--red);filter:brightness(1.07)}
.sh-btn .i{width:18px;height:18px}
.is-empty #sh-skip,.is-empty #sh-seen,.is-empty #sh-undo:disabled{display:none}.is-empty .sh-controls{grid-template-columns:auto;justify-content:center}
@media (max-width:380px){#sh-undo{padding:0 14px}#sh-undo span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.sh-all span{display:none}.sh-all{padding:0 11px}}
.sh-state{max-width:320px;text-align:center;display:grid;gap:10px;justify-items:center;padding:0 8px}
.sh-state h2{font:600 24px/1.2 var(--serif);letter-spacing:-.01em;margin:0}.sh-state p{margin:0;color:var(--ink-2);font-size:14.5px;line-height:1.55;text-wrap:balance}
.sh-state .sh-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:8px}.sh-state .btn{min-height:44px;padding:0 16px}
.sh-keys{display:none}
@media (pointer:fine) and (min-height:640px){.sh-keys{display:flex;flex:none;justify-content:center;flex-wrap:wrap;gap:4px 16px;margin:0;padding:0 16px 14px;font-size:12.5px;color:var(--ink-3)}}
.sh-keys kbd{font:600 11px/1 var(--sans);border:1px solid var(--rule-2);border-bottom-width:2px;border-radius:5px;padding:3px 6px;margin-right:6px;color:var(--ink-2);background:var(--surface)}
.sh-player{position:relative}.sh-toast{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(max(12px,env(safe-area-inset-bottom)) + 62px);z-index:30;text-wrap:balance;display:flex;align-items:center;gap:12px;background:var(--ink);color:var(--paper);border-radius:12px;padding:12px 16px;font:500 14px/1.35 var(--sans);box-shadow:var(--shadow);width:max-content;max-width:calc(100vw - 32px)}
.sh-toast[hidden]{display:none}
@media (max-height:760px){.sh-body .bar-in{height:48px}.sh-head{min-height:44px;padding-top:2px}.sh-h{font-size:20px}.sh-all{min-height:36px}.sh-btn{min-height:46px}.sh-player{gap:8px}.sh-stage{padding-top:6px}}
.sh-noscript{text-align:center;color:var(--ink-2);padding:24px}
`;
const SHORTS_JS = `
(function(){
var K_SEEN='wire.shorts.seen',K_SOUND='wire.shorts.sound',K_TIP='wire.shorts.tip',tipOn=false,YT='https://www.youtube.com';
function lsGet(k){try{return localStorage.getItem(k)}catch(_){return null}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(_){}}
var seen={};try{(JSON.parse(lsGet(K_SEEN)||'[]')||[]).forEach(function(id){seen[id]=1})}catch(_){}
function saveSeen(){lsSet(K_SEEN,JSON.stringify(Object.keys(seen).slice(-3000)))}
function $(id){return document.getElementById(id)}
var player=$('sh-player'),slot=$('sh-slot'),nEl=$('sh-n'),fill=$('sh-fill'),meter=$('sh-meter'),allBtn=$('sh-all'),undoBtn=$('sh-undo'),skipBtn=$('sh-skip'),seenBtn=$('sh-seen'),live=$('sh-live'),toast=$('sh-toast'),toastT=$('sh-toast-t');
var CHANNELS=player.getAttribute('data-channels')||'the channels';
var reduced=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
var ICON={up:'${I.up}',down:'${I.down}',on:'${I.soundOn}',off:'${I.soundOff}',play:'${I.playFill}',ext:'${I.ext}'};
var all=[],queue=[],done=0,hist=[],busy=false,sound=lsGet(K_SOUND)==='1',muted=true,playing=false,userPaused=false,frame=null,card=null,cur=null,loadedAt=0,toastTimer=0;

function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function btn(t,cls,f){var b=el('button',cls,t);b.type='button';b.addEventListener('click',f);return b}
function thumb(id){return 'https://i.ytimg.com/vi/'+encodeURIComponent(id)+'/hqdefault.jpg'}
function ago(iso){var s=(Date.now()-new Date(iso).getTime())/1000;if(s<3600)return Math.max(1,Math.floor(s/60))+' min ago';if(s<86400)return Math.floor(s/3600)+'h ago';var d=Math.floor(s/86400);return d===1?'Yesterday':d+' days ago'}
function plural(n,w){return n+' '+w+(n===1?'':'s')}
function announce(t){live.textContent='';setTimeout(function(){live.textContent=t},40)}
function buzz(){try{if(navigator.vibrate)navigator.vibrate(8)}catch(_){}}
function post(f,msg){try{if(f&&f.contentWindow)f.contentWindow.postMessage(JSON.stringify(msg),YT)}catch(_){}}
function cmd(fn,args){post(frame,{event:'command',func:fn,args:args||[]})}

function update(){var n=queue.length,t=done+n;
 nEl.textContent=n?n+' to watch':'';
 fill.style.width=(t?done/t*100:0)+'%';meter.setAttribute('aria-valuemax',String(t));meter.setAttribute('aria-valuenow',String(done));meter.setAttribute('aria-valuetext',done+' of '+t+' seen');
 allBtn.disabled=!n;seenBtn.disabled=!n;skipBtn.disabled=n<2;undoBtn.disabled=!hist.length;player.classList.toggle('is-empty',!n)}

function setMuted(m){muted=m;if(!card)return;var b=card.querySelector('.sh-mute');if(!b)return;b.innerHTML=m?ICON.off:ICON.on;b.setAttribute('aria-pressed',String(!m));b.setAttribute('aria-label',m?'Turn sound on':'Turn sound off')}
function setPlaying(p){playing=p;if(p)userPaused=false;if(card)card.classList.toggle('is-paused',!p&&userPaused)}
function setProg(x){if(!card)return;var s=card.querySelector('.sh-prog span');if(s)s.style.width=Math.max(0,Math.min(1,x))*100+'%'}
function flash(t){if(!card)return;var f=card.querySelector('.sh-flash');if(!f)return;f.textContent=t;f.classList.remove('show');void f.offsetWidth;f.classList.add('show')}
function toggleSound(){if(!cur)return;dismissTip();
 if(muted){cmd('unMute');cmd('playVideo');sound=true;lsSet(K_SOUND,'1');setMuted(false);flash('Sound on')}
 else{cmd('mute');sound=false;lsSet(K_SOUND,'0');setMuted(true);flash('Sound off')}}
function togglePlay(){if(!cur)return;if(playing){userPaused=true;cmd('pauseVideo');setPlaying(false)}else{cmd('playVideo');setPlaying(true)}}

function render(how){
 update();busy=false;frame=null;card=null;playing=false;userPaused=false;muted=true;
 if(!queue.length){cur=null;state('done');return}
 var v=queue[0];cur=v;slot.innerHTML='';
 card=el('div','sh-card'+(reduced?'':how==='up'?' sh-in-up':how==='down'||how==='undo'?' sh-in-down':''));
 var poster=el('img','sh-poster');poster.alt='';poster.decoding='async';poster.src=thumb(v.id);card.appendChild(poster);
 var f=document.createElement('iframe');frame=f;f.title=v.title;f.tabIndex=-1;f.allow='autoplay; encrypted-media; picture-in-picture';f.referrerPolicy='strict-origin-when-cross-origin';
 f.src=YT+'/embed/'+encodeURIComponent(v.id)+'?autoplay=1&mute=1&playsinline=1&loop=1&playlist='+encodeURIComponent(v.id)+'&rel=0&modestbranding=1&controls=0&disablekb=1&iv_load_policy=3&enablejsapi=1&origin='+encodeURIComponent(location.origin);
 f.addEventListener('load',function(){if(f!==frame)return;post(f,{event:'listening',id:1,channel:'widget'});cmd('addEventListener',['onStateChange'])});
 card.appendChild(f);
 var pad=el('div','sh-pad');pad.setAttribute('aria-hidden','true');card.appendChild(pad);
 var cu=el('div','sh-cue sh-cue-up');cu.innerHTML=ICON.up+'Seen';cu.setAttribute('aria-hidden','true');card.appendChild(cu);
 var cd=el('div','sh-cue sh-cue-down');cd.innerHTML=ICON.down+'Skip';cd.setAttribute('aria-hidden','true');card.appendChild(cd);
 var fl=el('div','sh-flash');fl.setAttribute('aria-hidden','true');card.appendChild(fl);
 var pz=el('div','sh-pz');pz.innerHTML=ICON.play;pz.setAttribute('aria-hidden','true');card.appendChild(pz);
 card.appendChild(btn('','sh-mute',toggleSound));
 var cap=el('div','sh-cap');cap.appendChild(el('p','sh-t',v.title));
 var m=el('p','sh-m');m.appendChild(el('span',null,v.channel+', '+ago(v.published)));
 var a=el('a','sh-yt');a.href=YT+'/shorts/'+encodeURIComponent(v.id);a.target='_blank';a.rel='noopener';a.innerHTML='YouTube'+ICON.ext;a.setAttribute('aria-label','Open on YouTube');m.appendChild(a);
 cap.appendChild(m);card.appendChild(cap);
 var pr=el('div','sh-prog');pr.setAttribute('aria-hidden','true');pr.appendChild(el('span'));card.appendChild(pr);
 slot.appendChild(card);setMuted(true);gestures(pad);
 if(queue[1]){var im=new Image();im.src=thumb(queue[1].id)}
 announce(v.title+', from '+v.channel);
}

function cues(d){if(!card)return;card.querySelector('.sh-cue-up').style.opacity=d<0?Math.min(1,-d/90):0;card.querySelector('.sh-cue-down').style.opacity=d>0&&queue.length>1?Math.min(1,d/90):0}
function gestures(pad){var st=null;
 pad.addEventListener('pointerdown',function(e){if(busy||e.button>0)return;st={y:e.clientY,t:Date.now()};card.style.transition='none';try{pad.setPointerCapture(e.pointerId)}catch(_){}});
 pad.addEventListener('pointermove',function(e){if(!st)return;var d=e.clientY-st.y;if(d>0&&queue.length<2)d=d*0.3;card.style.transform='translateY('+d+'px)';cues(d)});
 function end(e,cancel){if(!st)return;var d=e.clientY-st.y,dt=Math.max(1,Date.now()-st.t),vel=d/dt;st=null;card.style.transition='';cues(0);
  if(!cancel){
   if(Math.abs(d)<10&&dt<300){card.style.transform='';toggleSound();return}
   if(d<-90||(d<-30&&vel<-0.45)){act('seen');return}
   if(queue.length>1&&(d>90||(d>30&&vel>0.45))){act('skip');return}}
  card.style.transform=''}
 pad.addEventListener('pointerup',function(e){end(e,false)});pad.addEventListener('pointercancel',function(e){end(e,true)})}

function push(h){hist.push(h);if(hist.length>50)hist.shift()}
function act(k){if(busy||!cur)return;if(k==='skip'&&queue.length<2)return;busy=true;dismissTip();buzz();
 var v=queue[0],c=card;
 if(c&&!reduced){c.style.transition='';c.style.transform='translateY('+(k==='seen'?'-115%':'115%')+')';c.style.opacity='0'}
 setTimeout(function(){queue.shift();if(k==='seen'){seen[v.id]=1;saveSeen();done++}else queue.push(v);push({k:k,v:v});render(k==='seen'?'up':'down')},reduced?0:180)}
function undo(){if(busy||!hist.length)return;var h=hist.pop();hideToast();
 if(h.k==='seen'){delete seen[h.v.id];saveSeen();done=Math.max(0,done-1);queue.unshift(h.v)}
 else if(h.k==='skip'){var i=queue.lastIndexOf(h.v);if(i>0){queue.splice(i,1);queue.unshift(h.v)}}
 else if(h.k==='all'){h.vs.forEach(function(v){delete seen[v.id]});saveSeen();done=Math.max(0,done-h.vs.length);queue=h.vs.concat(queue.filter(function(v){return h.vs.indexOf(v)<0}))}
 else if(h.k==='reset'){h.ids.forEach(function(id){seen[id]=1});saveSeen();queue=queue.filter(function(v){return!seen[v.id]});done=h.done}
 render('undo');announce('Undone')}
function markAll(){if(busy||!queue.length)return;var vs=queue.slice();vs.forEach(function(v){seen[v.id]=1});saveSeen();done+=vs.length;queue=[];push({k:'all',vs:vs});buzz();render();toastMsg(plural(vs.length,'Short')+' marked as seen')}
function reset(){var ids=all.filter(function(v){return seen[v.id]}).map(function(v){return v.id});if(!ids.length)return;
 ids.forEach(function(id){delete seen[id]});saveSeen();push({k:'reset',ids:ids,done:done});done=0;
 var have={};queue.forEach(function(v){have[v.id]=1});queue=queue.concat(all.filter(function(v){return!have[v.id]&&!seen[v.id]}));
 render('up');toastMsg(plural(ids.length,'Short')+' back in the queue')}

function state(kind){slot.innerHTML='';update();var b=el('div','sh-state'),r=el('div','sh-row');
 if(kind==='done'){b.appendChild(el('h2',null,"You're up to date"));b.appendChild(el('p',null,'New Shorts from '+CHANNELS+' appear here as they post.'));
  r.appendChild(btn('Check for new','btn primary',function(e){refresh(true,e.currentTarget)}));
  if(all.some(function(v){return seen[v.id]}))r.appendChild(btn('Show seen Shorts','btn',reset))}
 else{b.appendChild(el('h2',null,"Couldn't load Shorts"));b.appendChild(el('p',null,"YouTube didn't respond. Check your connection, then try again."));r.appendChild(btn('Try again','btn primary',start))}
 b.appendChild(r);slot.appendChild(b)}
function fetchList(){return fetch('/api/shorts',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(l){if(!Array.isArray(l)||!l.length)throw new Error('empty');all=l;loadedAt=Date.now();return l})}
function start(){slot.innerHTML='';var s=el('div','sh-card sh-skel');s.setAttribute('aria-label','Loading Shorts');slot.appendChild(s);nEl.textContent='';
 fetchList().then(function(l){queue=l.filter(function(v){return!seen[v.id]});done=0;render();showTip()}).catch(function(){state('error')})}
function refresh(manual,b){if(b)b.disabled=true;
 fetchList().then(function(l){var have={};queue.forEach(function(v){have[v.id]=1});var fresh=l.filter(function(v){return!seen[v.id]&&!have[v.id]});
  if(fresh.length){if(queue.length){queue.splice.apply(queue,[1,0].concat(fresh));update()}else{queue=fresh;render('up')}toastMsg(plural(fresh.length,'new Short')+' added')}
  else{if(manual)toastMsg('No new Shorts yet');if(b)b.disabled=false}
 }).catch(function(){if(manual)toastMsg("Couldn't reach YouTube. Try again shortly.");if(b)b.disabled=false})}

function toastMsg(t,ms){tipOn=false;toastT.textContent=t;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(hideToast,ms||4000)}
function hideToast(){toast.hidden=true;clearTimeout(toastTimer)}
function showTip(){if(!lsGet(K_TIP)&&window.matchMedia&&matchMedia('(pointer: coarse)').matches&&cur){toastMsg('Swipe up when seen, down to skip. Tap the video for sound.',9000);tipOn=true}}
function dismissTip(){if(tipOn){tipOn=false;lsSet(K_TIP,'1');hideToast()}}

window.addEventListener('message',function(e){if(!frame||e.source!==frame.contentWindow||e.origin!==YT)return;var d=e.data;
 if(typeof d==='string'){try{d=JSON.parse(d)}catch(_){return}}if(!d||typeof d!=='object')return;
 if(d.event==='onReady'){if(sound)cmd('unMute');cmd('playVideo')}
 if(d.event==='onStateChange'&&typeof d.info==='number')setPlaying(d.info===1);
 var i=(d.event==='infoDelivery'||d.event==='initialDelivery')?d.info:null;
 if(i&&typeof i==='object'){if(typeof i.muted==='boolean')setMuted(i.muted);if(typeof i.playerState==='number')setPlaying(i.playerState===1);if(typeof i.currentTime==='number'&&i.duration>0)setProg(i.currentTime/i.duration)}});
document.addEventListener('keydown',function(e){if(e.altKey||e.metaKey)return;var tag=(e.target&&e.target.tagName)||'';if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;var k=e.key;
 if(e.ctrlKey){if(k==='z'){e.preventDefault();undo()}return}
 if(k==='ArrowUp'||k==='k'){e.preventDefault();act('seen')}
 else if(k==='ArrowDown'||k==='j'){e.preventDefault();act('skip')}
 else if(k==='m'||k==='M'){toggleSound()}
 else if(k==='u'||k==='U'){undo()}
 else if(k===' '&&tag!=='BUTTON'&&tag!=='A'){e.preventDefault();togglePlay()}});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&loadedAt&&Date.now()-loadedAt>300000)refresh(false)});
seenBtn.addEventListener('click',function(){act('seen')});skipBtn.addEventListener('click',function(){act('skip')});undoBtn.addEventListener('click',undo);allBtn.addEventListener('click',markAll);
start();
})();
`;

// ---------- squad data: read from Postgres, written by the squad poller ----------
const db = env.DATABASE_URL ? new SQL({ url: env.DATABASE_URL, max: 3, idleTimeout: 60, connectionTimeout: 5 }) : null;
const CLUB = env.SQUAD_CLUB || "LIV";
type SquadData = { model: SquadModel | null; season: string; lastOk: string | null; last: { at: string; ok: boolean; error: string | null } | null };
let squadCache: { at: number; data: SquadData | null } = { at: 0, data: null };
let squadInflight: Promise<SquadData | null> | null = null;
const isoOf = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const numOf = (v: unknown) => (v == null ? 0 : Number(v));
async function loadSquad(): Promise<SquadData | null> {
  if (!db) return null;
  if (Date.now() - squadCache.at < 120_000) return squadCache.data;
  squadInflight ??= (async () => {
    try {
      const runs = await db`select at, ok, season, error from fpl_runs order by at desc, id desc limit 200`;
      const okRun = runs.find((r: any) => r.ok);
      if (!okRun) { squadCache = { at: Date.now(), data: runs.length ? { model: null, season: "", lastOk: null, last: { at: isoOf(runs[0].at)!, ok: false, error: runs[0].error } } : null }; return squadCache.data; }
      const season = okRun.season as string;
      const [players, teams, fixtures, events] = await Promise.all([
        db`select * from fpl_players where season = ${season}`,
        db`select id, name, short_name from fpl_teams where season = ${season}`,
        db`select id, event, kickoff, team_h, team_a, h_score, a_score, finished, appeared_h, appeared_a from fpl_fixtures where season = ${season}`,
        db`select e.id, e.at, e.status, e.chance, e.news, e.prev_status from fpl_status_events e join fpl_players p using (season, id) join fpl_teams t on t.season = p.season and t.id = p.team where e.season = ${season} and t.short_name = ${CLUB}`,
      ]);
      const ps: SqPlayer[] = players.map((r: any) => ({ ...r, xg: numOf(r.xg), xa: numOf(r.xa), xgc: numOf(r.xgc), news: r.news ?? "", news_added: isoOf(r.news_added) }));
      const fx: SqFixture[] = fixtures.map((r: any) => ({ ...r, kickoff: isoOf(r.kickoff)!, appeared_h: r.appeared_h ? [...r.appeared_h].map(Number) : null, appeared_a: r.appeared_a ? [...r.appeared_a].map(Number) : null }));
      const evs: SqEvent[] = events.map((r: any) => ({ ...r, at: isoOf(r.at)!, news: r.news ?? "" }));
      const model = buildSquad({ players: ps, teams: [...teams], fixtures: fx, events: evs, club: CLUB, now: new Date() });
      squadCache = { at: Date.now(), data: { model, season, lastOk: isoOf(okRun.at), last: { at: isoOf(runs[0].at)!, ok: !!runs[0].ok, error: runs[0].error } } };
    } catch (e) { console.error("squad read failed", String(e)); squadCache.at = Date.now() - 90_000; } // keep the last good copy, retry in 30 seconds
    return squadCache.data;
  })().finally(() => { squadInflight = null; });
  return squadInflight;
}

// ---------- squad page ----------
const Q_BINS = [10, 25, 40, 60, 75, 90]; // percentile edges for the seven colour steps
const qClass = (pct: number | null) => (pct == null ? "q-na" : `q${Q_BINS.filter((b) => pct >= b).length}`);
const ordinal = (n: number) => { const r = Math.round(n), t = r % 100, u = r % 10; return `${r}${t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"}`; };
function fmtStat(st: SqStat, v: number | null) {
  if (v == null) return "";
  if (st.unit === "pct") return `${Math.round(v)}%`;
  const s = Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return st.key === "finishing" || st.key === "prevented" ? (v > 0 ? `+${s}` : s) : s;
}
const shortDate = (iso: string) => fmt(iso, { day: "numeric", month: "short" });
const AVAIL_LABEL: Record<Avail, string> = { played: "Played", injured: "Injured or doubtful", suspended: "Suspended", out: "Didn't play" };

function squadPage(st: State | null, d: SquadData | null) {
  const title = "Squad · LFC Wire";
  const m = d?.model;
  if (!m) return shell({ title, active: "squad", state: st, body: `${crumb("Squad")}${emptyState("Squad data isn't loaded yet", d?.last?.error ? `Last attempt failed: ${d.last.error}` : "It refreshes every two hours.")}` });

  // Out now: everyone flagged, with the latest fitness story on the wire that names them.
  const fit = st ? stories(st).filter((s) => s.group === "fitness" && Date.now() - new Date(s.latest).getTime() < 21 * 864e5) : [];
  const flagged = m.rows.filter((r) => r.flag);
  const outNow = flagged.map((r) => {
    const re = nameMatcher(r.p);
    let story: Story | undefined, item: Item | undefined;
    for (const s of re ? fit : []) { item = s.items.find((x) => textMatches(re!, `${x.summary ?? ""} ${x.title}`)); if (item) { story = s; break; } }
    const since = r.current?.start ?? r.p.news_added;
    return `<li class="out"><span class="out-n">${esc(r.p.web_name)}</span><span class="pill ${r.flag!.tone}">${esc(r.flag!.text)}</span>
<span class="out-m">${esc(r.what || r.p.news.split(" - ")[0] || "")}${since ? ` · since ${esc(shortDate(since))}` : ""}${r.current ? ` · missed ${r.current.missed}` : ""}</span>
${story && item ? `<a class="out-s" href="/#s-${esc(story.id)}">${esc(item.summary || item.title)}</a>` : ""}</li>`;
  }).join("");

  // Availability: one row per player, one column per league match.
  const head = m.matches.map((f) => `<th scope="col" title="${esc(`${f.home ? "v" : "at"} ${f.opp}, ${shortDate(f.kickoff)}, ${f.home ? `${f.h_score}-${f.a_score}` : `${f.a_score}-${f.h_score}`}`)}"><span>${esc(f.opp)}</span><span class="ha">${f.home ? "H" : "A"}</span></th>`).join("");
  const availRows = m.rows.filter((r) => r.p.pos !== 1 || r.p.minutes > 0 || r.flag).map((r) => `<tr><th scope="row">${esc(r.p.web_name)}</th>${r.avail.map((a, i) => `<td><span class="av av-${a}" title="${esc(`${m.matches[i].opp}: ${AVAIL_LABEL[a]}`)}"><span class="sr-only">${esc(AVAIL_LABEL[a])}</span></span></td>`).join("")}</tr>`).join("");
  const legend = (["played", "injured", "suspended", "out"] as Avail[]).map((a) => `<span class="lg"><span class="av av-${a}" aria-hidden="true"></span>${esc(AVAIL_LABEL[a])}</span>`).join("");

  // One heatmap per position.
  const positions = [1, 2, 3, 4].map((pos) => {
    const info = SQ_POS[pos], rows = m.rows.filter((r) => r.p.pos === pos);
    if (!rows.length) return "";
    const n = m.pools[pos]?.length ?? 0;
    const hdr = `<div class="hm-row hm-head" aria-hidden="true"><span></span>${info.stats.map((s) => `<span class="hm-h">${esc(s.label)}</span>`).join("")}</div>`;
    const few = rows.filter((r) => r.p.minutes < 90);
    const body = rows.filter((r) => r.p.minutes >= 90).map((r) => {
      const cells = r.cells.map((c) => {
        const v = fmtStat(c.stat, c.value);
        const lbl = `${c.stat.label}${c.stat.unit === "p90" ? " per 90" : ""}: ${v || "none"}${c.pct != null ? `, ${ordinal(c.pct)} percentile` : ", not ranked"}`;
        return `<span class="hm-c ${qClass(c.pct)}" title="${esc(lbl)}" aria-label="${esc(lbl)}"><b>${esc(v)}</b>${c.pct != null ? `<i>${Math.round(c.pct)}</i>` : ""}</span>`;
      }).join("");
      const sub = `${r.p.minutes} min`;
      const mark = r.flag ? `<span class="mk ${r.flag.tone}" role="img" aria-label="${esc(r.flag.text)}" title="${esc(r.flag.text)}"></span>` : "";
      return `<details class="pr" data-pid="${r.p.id}" data-pos="${pos}"${r.ranked ? "" : ' data-unranked=""'}><summary class="hm-row"><span class="hm-n"><span class="hm-name">${mark}${esc(r.p.web_name)}</span><span class="hm-sub">${sub}</span></span>${cells}</summary><div class="pr-x" aria-live="polite"></div></details>`;
    }).join("");
    return `<section class="sec sq-pos" id="pos-${pos}"><h2 class="sec-h">${esc(info.many)}<span class="sec-meta">vs ${n} Premier League ${esc(info.one)}s, ${Math.round(m.threshold)}+ min</span></h2>${hdr}<div class="hm">${body}</div>${few.length ? `<p class="hm-few"><span>Under 90 min</span> ${few.map((r) => `${esc(r.p.web_name)} ${r.p.minutes}${r.flag ? ` <span class="fl ${r.flag.tone}">${esc(r.flag.text)}</span>` : ""}`).join(", ")}</p>` : ""}</section>`;
  }).join("");

  const scale = `<div class="qscale" aria-hidden="true"><span class="qs-l">Bottom</span>${[0, 1, 2, 3, 4, 5, 6].map((i) => `<span class="qs q${i}"></span>`).join("")}<span class="qs-l">Top</span><span class="qs-l qs-na"><span class="qs q-na"></span>Too few minutes</span></div>`;
  const data = { club: m.team.short_name, stats: Object.fromEntries([1, 2, 3, 4].map((p) => [p, SQ_POS[p].stats.map((s) => ({ k: s.key, l: s.label, b: s.better, u: s.unit }))])), pools: m.pools,
    mine: Object.fromEntries(m.rows.map((r) => [r.p.id, { n: r.p.web_name, v: r.cells.map((c) => (c.value == null ? null : Math.round(c.value * 1000) / 1000)), p: r.cells.map((c) => (c.pct == null ? null : Math.round(c.pct))), r: r.ranked }])) };
  const body = `${crumb("Squad")}<header class="page-h"><h1>Squad</h1><p class="sq-meta">Premier League ${esc(d!.season)} · ${m.played} matches · per 90 minutes${d!.lastOk ? ` · ${timeTag(d!.lastOk)}` : ""}</p></header>
${outNow ? `<section class="sec"><h2 class="sec-h">Out now</h2><ul class="outs">${outNow}</ul></section>` : ""}
${scale}
${positions}
${m.matches.length ? `<section class="sec"><h2 class="sec-h">Availability</h2><div class="avl" role="group" aria-label="Availability by match">${legend}</div><div class="avt-wrap"><table class="avt"><thead><tr><th scope="col"><span class="sr-only">Player</span></th>${head}</tr></thead><tbody>${availRows}</tbody></table></div></section>` : ""}
${m.away.length ? `<p class="sq-away"><span>Left or on loan</span> ${m.away.map((p) => esc(p.web_name)).join(", ")}</p>` : ""}
<script type="application/json" id="sq-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
  return shell({ title, active: "squad", state: st, body, css: SQUAD_CSS, script: SQUAD_JS + "initSquad();" });
}

const SQUAD_CSS = `
.sq-meta{margin:0;font-size:13.5px;color:var(--ink-3)}
.sec-meta{display:block;font:400 12.5px/1.3 var(--sans);font-variation-settings:"wdth" 100;color:var(--ink-3);margin-top:3px}
.sq-pos,.sq-pos+section{margin-top:26px}
.outs{list-style:none;margin:0;padding:0}
.out{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rule)}
.out-n{font-weight:700}.out-m,.out-s{grid-column:1/-1;font-size:13px;color:var(--ink-3)}
.out-s{color:var(--ink-2);text-underline-offset:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pill{justify-self:start;font:700 11.5px/1 var(--sans);padding:4px 7px;border-radius:999px;background:var(--st-serious);color:#111820}
.pill.warn,.fl.warn{background:var(--st-warn)}
.fl{font-weight:700;color:#111820;background:var(--st-serious);border-radius:3px;padding:1px 4px;font-size:11px}
:root{--q0:#b8501f;--q1:#c4714e;--q2:#d0947a;--q3:#e2e0db;--q4:#7999c4;--q5:#4b7ab8;--q6:#1c5cab;--q0t:#fff;--q1t:#111820;--q2t:#111820;--q3t:#111820;--q4t:#111820;--q5t:#fff;--q6t:#fff;
--st-serious:#ec835a;--st-warn:#fab219;--av-played:var(--ink-2)}
@media (prefers-color-scheme:dark){:root{--q0:#e07a45;--q1:#b76c47;--q2:#976047;--q3:#30363c;--q4:#4b729f;--q5:#5384bf;--q6:#5c9ce8;--q0t:#0E1215;--q1t:#0E1215;--q2t:#E9EDF0;--q3t:#E9EDF0;--q4t:#E9EDF0;--q5t:#0E1215;--q6t:#0E1215;--av-played:var(--ink-2)}}
.q0{background:var(--q0);color:var(--q0t)}.q1{background:var(--q1);color:var(--q1t)}.q2{background:var(--q2);color:var(--q2t)}.q3{background:var(--q3);color:var(--q3t)}
.q4{background:var(--q4);color:var(--q4t)}.q5{background:var(--q5);color:var(--q5t)}.q6{background:var(--q6);color:var(--q6t)}
.q-na{background:repeating-linear-gradient(135deg,transparent 0 4px,color-mix(in srgb,var(--ink) 9%,transparent) 4px 5px);color:var(--ink-3);box-shadow:inset 0 0 0 1px var(--rule)}
.qscale{display:flex;align-items:center;gap:2px;flex-wrap:wrap;margin:6px 0 0;font-size:12px;color:var(--ink-3)}
.qs{width:18px;height:12px;border-radius:2px;display:inline-block}.qs-l{margin:0 6px}.qs-l:first-child{margin-left:0}.qs-na{display:inline-flex;align-items:center;gap:6px;margin-left:14px}
.hm-row{display:grid;grid-template-columns:minmax(0,1fr) repeat(5,50px);gap:2px;align-items:stretch}
@media (min-width:560px){.hm-row{grid-template-columns:minmax(0,1fr) repeat(5,64px)}}
@media (min-width:860px){.hm-row{grid-template-columns:minmax(0,220px) repeat(5,minmax(0,1fr))}}
.hm-head{padding:2px 0 6px}.hm-h{font:600 11.5px/1.15 var(--sans);font-variation-settings:"wdth" 75;color:var(--ink-2);text-align:center;align-self:end;white-space:normal}
@media (min-width:560px){.hm-h{font-size:12.5px;font-variation-settings:"wdth" 90}}
.pr{border-top:2px solid transparent}
.pr>summary{list-style:none;cursor:pointer;padding:0;min-height:44px}.pr>summary::-webkit-details-marker{display:none}
.pr>summary:hover .hm-name{text-decoration:underline;text-underline-offset:3px}
.hm-n{display:flex;flex-direction:column;justify-content:center;min-width:0;padding:4px 6px 4px 0}
.hm-name{font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hm-sub{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hm-c{display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:3px;min-height:44px;font-variant-numeric:tabular-nums;line-height:1.1}
.hm-c b{font-size:13.5px;font-weight:700}.hm-c i{font-style:normal;font-size:10.5px;opacity:.85}
.mk{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--st-serious);margin-right:6px;vertical-align:1px}.mk.warn{background:var(--st-warn)}
.hm-few{margin:8px 0 0;font-size:13px;color:var(--ink-3);line-height:1.7}.hm-few>span:first-child{font-weight:600;color:var(--ink-2);margin-right:4px}
.pr[open]>summary .hm-name{font-weight:800}
.pr-x{padding:8px 0 14px}
.strip{display:grid;grid-template-columns:minmax(0,1fr);gap:2px;margin:0 0 10px}
.strip-h{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--ink-3)}.strip-h b{color:var(--ink);font-weight:700}
.strip svg{display:block;width:100%;height:auto;overflow:visible;touch-action:pan-y}
.strip .dot{fill:var(--ink-3);opacity:.32}.strip .mate{fill:var(--ink-2);opacity:.85}.strip .me{fill:var(--ink);stroke:var(--paper);stroke-width:2}.strip .med{stroke:var(--ink-3);stroke-width:1;stroke-dasharray:2 2}
.strip .ax{font:500 10px var(--sans);fill:var(--ink-3)}
.tip{position:fixed;z-index:60;pointer-events:none;background:var(--ink);color:var(--paper);font:500 12.5px/1.3 var(--sans);padding:6px 8px;border-radius:6px;box-shadow:var(--shadow);white-space:nowrap}
.avl{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--ink-3);margin:0 0 8px}.lg{display:inline-flex;align-items:center;gap:6px}
.avt-wrap{overflow-x:auto;margin:0 -16px;padding:0 16px}
.avt{border-collapse:separate;border-spacing:2px;font-size:13px}
.avt th{font-weight:600;text-align:left;white-space:nowrap}
.avt thead th{font:600 10.5px/1.15 var(--sans);color:var(--ink-3);text-align:center;vertical-align:bottom;min-width:22px}.avt thead th span{display:block}.avt .ha{font-weight:400}
.avt tbody th{position:sticky;left:0;background:var(--paper);padding-right:8px;font-weight:500;max-width:120px;overflow:hidden;text-overflow:ellipsis}
.avt td{padding:0}
.av{display:inline-block;width:20px;height:20px;border-radius:3px;vertical-align:middle}
.lg .av{width:12px;height:12px}
.av-played{background:var(--av-played)}.av-injured{background:var(--st-serious)}.av-suspended{background:var(--st-warn)}.av-out{box-shadow:inset 0 0 0 1px var(--rule-2)}
.sq-away{margin:22px 0 0;font-size:13px;color:var(--ink-3)}.sq-away span{font-weight:600;color:var(--ink-2);margin-right:4px}
`;

// Strip plots: every ranked player at the position as a dot, this player on top. Right is always better.
const SQUAD_JS = `
function initSquad(){
 var el=document.getElementById('sq-data');if(!el)return;var D=JSON.parse(el.textContent);
 var tip=document.createElement('div');tip.className='tip';tip.hidden=true;document.body.appendChild(tip);
 function f(v,s){if(v==null)return '';if(s.u==='pct')return Math.round(v)+'%';var t=Math.abs(v)>=10?v.toFixed(1):v.toFixed(2);return (s.k==='finishing'||s.k==='prevented')&&v>0?'+'+t:t}
 function ord(n){var t=n%100,u=n%10;return n+(t>=11&&t<=13?'th':u===1?'st':u===2?'nd':u===3?'rd':'th')}
 var NS='http://www.w3.org/2000/svg';
 function mk(tag,a){var e=document.createElementNS(NS,tag);for(var k in a)e.setAttribute(k,a[k]);return e}
 function draw(box,pos,pid){
  var stats=D.stats[pos],pool=D.pools[pos]||[],me=D.mine[pid];if(!me)return;box.innerHTML='';
  stats.forEach(function(s,i){
   var vals=pool.map(function(p){return p.v[i]}).filter(function(v){return v!=null}).sort(function(a,b){return a-b});
   var mv=me.v[i];if(!vals.length&&mv==null)return;
   var lo=vals.length?vals[Math.floor(vals.length*0.02)]:mv,hi=vals.length?vals[Math.ceil(vals.length*0.98)-1]:mv;
   if(mv!=null){lo=Math.min(lo,mv);hi=Math.max(hi,mv)}if(hi===lo){hi=lo+1}
   var W=Math.max(200,box.clientWidth||320),H=34,pad=8,flip=s.b==='low';
   function x(v){var c=Math.max(lo,Math.min(hi,v)),t=(c-lo)/(hi-lo);return pad+(flip?1-t:t)*(W-2*pad)}
   var wrap=document.createElement('div');wrap.className='strip';
   var h=document.createElement('div');h.className='strip-h';
   var rank=me.r&&mv!=null?vals.filter(function(v){return flip?v<mv-1e-9:v>mv+1e-9}).length+1:null;
   var ties=rank!=null?vals.filter(function(v){return Math.abs(v-mv)<=1e-9}).length:0;
   h.innerHTML='<span>'+s.l+(s.u==='p90'?' per 90':'')+'</span><span><b>'+f(mv,s)+'</b>'+(rank!=null?' · '+(ties>1?'joint ':'')+ord(rank)+' of '+vals.length:' · not ranked')+'</span>';
   var svg=mk('svg',{viewBox:'0 0 '+W+' '+(H+12),width:W,height:H+12,role:'img','aria-label':s.l+': '+me.n+' '+f(mv,s)+(me.p[i]!=null?', '+ord(me.p[i])+' percentile':'')});
   var med=vals.length?vals[Math.floor(vals.length/2)]:null;
   if(med!=null)svg.appendChild(mk('line',{'class':'med',x1:x(med),x2:x(med),y1:4,y2:H-4}));
   [[lo,flip?'end':'start'],[hi,flip?'start':'end']].forEach(function(e){var t=mk('text',{x:x(e[0]),y:H+10,'class':'ax','text-anchor':e[1]});t.textContent=f(e[0],s);svg.appendChild(t)});
   var pts=[];
   pool.forEach(function(p,j){var v=p.v[i];if(v==null)return;var mate=p.t===D.club;var y=6+((j*7919)%97)/97*(H-12);
    var c=mk('circle',{cx:x(v),cy:y,r:mate?3.2:2.6,'class':mate?'dot mate':'dot'});svg.appendChild(c);pts.push({x:x(v),y:y,n:p.n,t:p.t,v:v})});
   if(mv!=null)svg.appendChild(mk('circle',{cx:x(mv),cy:H/2,r:6,'class':'me'}));
   function show(e){var r=svg.getBoundingClientRect(),sx=W/r.width,sy=(H+12)/r.height,px=(e.clientX-r.left)*sx,py=(e.clientY-r.top)*sy,best=null,bd=1e9;
    pts.forEach(function(p){var d=Math.pow((p.x-px)/sx,2)+Math.pow((p.y-py)/sy,2);if(d<bd){bd=d;best=p}});
    if(!best||bd>18*18){tip.hidden=true;return}
    tip.textContent=best.n+' ('+best.t+') '+f(best.v,s);tip.hidden=false;
    var tx=Math.min(window.innerWidth-tip.offsetWidth-8,Math.max(8,e.clientX-tip.offsetWidth/2));tip.style.left=tx+'px';tip.style.top=(e.clientY-40)+'px'}
   svg.addEventListener('pointermove',show);svg.addEventListener('pointerdown',show);svg.addEventListener('pointerleave',function(){tip.hidden=true});
   wrap.appendChild(h);wrap.appendChild(svg);box.appendChild(wrap)});
 }
 document.querySelectorAll('details.pr').forEach(function(d){d.addEventListener('toggle',function(){if(d.open){var b=d.querySelector('.pr-x');if(!b.firstChild)draw(b,d.dataset.pos,d.dataset.pid)}})});
 document.addEventListener('scroll',function(){tip.hidden=true},{passive:true});
}
`;

// The squad tables must never hold up the wire: give up after four seconds and render without them.
const squadOrTimeout = () => Promise.race([loadSquad().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);

// ---------- server ----------
const html = (b: string) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
Bun.serve({
  port: Number(env.PORT || 3000),
  async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/health") return new Response("ok");
    // Send page views on the old railway.app address to the canonical domain. Service worker, icons and push API stay put so existing installs keep working.
    const canon = env.CANONICAL_HOST, host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(":")[0];
    if (canon && host && host !== canon && host.endsWith(".up.railway.app") && req.method === "GET" && (path === "/" || path === "/filtered" || path === "/status" || path === "/shorts" || path === "/squad"))
      return new Response(null, { status: 301, headers: { location: `https://${canon}${path}${url.search}` } });
    if (path === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json" } });
    if (path === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (PNG[path]) return new Response(PNG[path] as unknown as BodyInit, { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" } });
    if (path.startsWith("/api/push/")) {
      if (path === "/api/push/key") return Response.json({ key: VAPID_PUBLIC });
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        const bodyIn: any = await req.json().catch(() => ({}));
        if (path === "/api/push/subscribe") {
          if (!validSub(bodyIn)) return Response.json({ error: "bad subscription" }, { status: 400 });
          const subs = (await readSubs()).filter((x) => x.endpoint !== bodyIn.endpoint);
          const isNew = subs.length === (await readSubs()).length;
          subs.unshift({ endpoint: bodyIn.endpoint, keys: { p256dh: bodyIn.keys.p256dh, auth: bodyIn.keys.auth }, added: new Date().toISOString(), ua: (req.headers.get("user-agent") || "").slice(0, 120) });
          await writeSubs(subs.slice(0, MAX_SUBS));
          if (isNew) await sendPush(subs[0], { title: "LFC Wire", body: "Alerts are on. You will hear from me when material news breaks.", tag: "welcome", url: "/" }).catch((e) => console.error("welcome push failed", String(e)));
          return Response.json({ ok: true });
        }
        if (path === "/api/push/unsubscribe") {
          await writeSubs((await readSubs()).filter((x) => x.endpoint !== bodyIn.endpoint));
          return Response.json({ ok: true });
        }
        if (path === "/api/push/test") {
          const sub = (await readSubs()).find((x) => x.endpoint === bodyIn.endpoint);
          if (!sub) return Response.json({ error: "not subscribed" }, { status: 404 });
          const code = await sendPush(sub, { title: "LFC Wire test", body: "This is what an alert looks like. Tap to open the wire.", tag: "test", url: "/" });
          return code < 300 ? Response.json({ ok: true }) : Response.json({ error: `push service returned ${code}` }, { status: 502 });
        }
      } catch (e) { console.error("push api failed", path, String(e)); return Response.json({ error: "server error" }, { status: 500 }); }
      return new Response("Not found", { status: 404 });
    }
    if (path === "/shorts") return new Response(shortsPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-robots-tag": "noindex" } });
    if (path === "/api/shorts") {
      try { return Response.json(await loadShorts(), { headers: { "cache-control": "public, max-age=120" } }); }
      catch (e) { console.error("shorts failed", String(e)); return Response.json([], { status: 502 }); }
    }
    const st = await loadState();
    try {
      if (path === "/") return html(wirePage(st));
      if (path === "/filtered") return html(filteredPage(st));
      if (path === "/status") return html(statusPage(st, await squadOrTimeout()));
      if (path === "/squad") return html(squadPage(st, await squadOrTimeout()));
      if (path === "/api/version") return Response.json({ lastRun: st?.lastRun ?? null, stories: st ? stories(st).length : 0 }, { headers: { "cache-control": "no-store" } });
      if (path === "/api/state.json") return new Response(cached.raw || "null", { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) { console.error("render failed", path, String(e)); return new Response("Something went wrong rendering this page.", { status: 500 }); }
    return new Response("Not found", { status: 404 });
  },
});
console.log("web up");
