// LFC wire: poller. Runs on a Railway cron schedule, exits when done.
// Fetches tier 1 sources only, filters and summarises new items with Gemini Flash (structured outputs),
// clusters duplicates, pushes material items as web push notifications, writes state.json to a bucket. The web service renders it.
import { S3Client } from "bun";
import webpush from "web-push@3";
import { XMLParser } from "fast-xml-parser@4";

// ---------- config ----------
const env = Bun.env;
const MODEL = env.GEMINI_MODEL || "gemini-3.8-flash";
const THINKING_LEVEL = env.GEMINI_THINKING_LEVEL || "low"; // lowest level 3.8 Flash accepts; set "" to omit
const DAILY_TOKEN_CAP = Number(env.DAILY_TOKEN_CAP || 150000);
const RETAIN_DAYS = 14;
const INGEST_MAX_AGE_H = Number(env.INGEST_MAX_AGE_H || 72); // older items are not news
const MAX_PUSH_PER_DAY = Number(env.MAX_PUSH_PER_DAY || 6);
const QUIET_START = Number(env.QUIET_START_HOUR || 22);
const QUIET_END = Number(env.QUIET_END_HOUR || 7);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const ONLY = (env.SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);

type Source = { key: string; name: string; kind: "rss" | "lfc"; url: string };
const SOURCES: Source[] = [
  { key: "lfc", name: "liverpoolfc.com", kind: "lfc", url: "https://www.liverpoolfc.com/news" },
  { key: "sky", name: "Sky Sports", kind: "rss", url: "https://www.skysports.com/rss/11669" },
  { key: "bbc", name: "BBC Sport", kind: "rss", url: "https://feeds.bbci.co.uk/sport/football/teams/liverpool/rss.xml" },
  { key: "echo", name: "Liverpool Echo", kind: "rss", url: "https://www.liverpoolecho.co.uk/all-about/liverpool-fc?service=rss" },
  { key: "athletic", name: "The Athletic", kind: "rss", url: "https://www.nytimes.com/athletic/rss/football/liverpool/" },
].filter((s) => ONLY.length === 0 || ONLY.includes(s.key));

// ---------- storage: bucket if configured, else local ./data ----------
// Bun's virtual-hosted mode expects the bucket already in the endpoint host (https://<bucket>.t3.storageapi.dev)
const vhEndpoint = () => {
  const ep = env.S3_ENDPOINT || "";
  if (env.S3_VIRTUAL_HOSTED !== "true" || !ep || !env.S3_BUCKET) return ep;
  const u = new URL(ep); if (!u.hostname.startsWith(env.S3_BUCKET + ".")) u.hostname = `${env.S3_BUCKET}.${u.hostname}`;
  return u.toString().replace(/\/$/, "");
};
const useS3 = !!(env.S3_BUCKET && env.S3_ACCESS_KEY_ID);
const s3 = useS3
  ? new S3Client({
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      bucket: env.S3_BUCKET!,
      endpoint: vhEndpoint(),
      region: env.S3_REGION || "auto",
      virtualHostedStyle: env.S3_VIRTUAL_HOSTED === "true",
    })
  : null;
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const waits = [1000, 4000, 12000];
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= waits.length) throw e; console.error(`${what} failed (${String(e).slice(0, 120)}), retry ${i + 1} in ${waits[i] / 1000}s`); await Bun.sleep(waits[i]); }
  }
}
async function readText(key: string): Promise<string | null> {
  try {
    if (s3) return await withRetry(`read ${key}`, async () => { const f = s3.file(key); return (await f.exists()) ? await f.text() : null; });
    const f = Bun.file(`./data/${key}`); return (await f.exists()) ? await f.text() : null;
  } catch (e) { console.error("read failed, aborting run so state is not overwritten", key, String(e)); throw e; }
}
async function writeText(key: string, body: string, type: string) {
  if (s3) await withRetry(`write ${key}`, () => s3.write(key, body, { type }));
  else await Bun.write(`./data/${key}`, body);
}

// ---------- types ----------
type Item = {
  id: string; url: string; source: string; title: string; standfirst: string;
  published: string; fetched: string;
  status: "pending" | "kept" | "dropped";
  category?: string; summary?: string; reason?: string; material?: boolean;
  cluster?: string; pushed?: boolean; dropKind?: string;
};
type SourceHealth = { lastOk?: string; lastError?: string; lastErrorAt?: string; lastCount?: number; fails: number; alerted?: boolean };
type State = {
  items: Item[];
  health: Record<string, SourceHealth>;
  usage: Record<string, { in: number; out: number; calls: number }>;
  pushes: Record<string, number>;
  lastRun?: string;
  modelError?: string;
  fixtures?: { fetchedAt: string; events: Fixture[] };
};
type Fixture = { start: string; home: string; away: string; venue: string; url: string; competition?: string };

// ---------- helpers ----------
const nowIso = () => new Date().toISOString();
const ukParts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, hm: `${p.hour}:${p.minute}` };
};
const fmtTime = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const decode = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const normUrl = (u: string) => { try { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString().replace(/\/$/, ""); } catch { return u; } };
const hashId = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex").slice(0, 12);
async function get(url: string, timeoutMs = 20000): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

// ---------- fetchers ----------
type Raw = { url: string; title: string; standfirst: string; published: string };
const xml = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" });
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v.__cdata ?? v["#text"] ?? "") : String(v));

async function fetchRss(src: Source): Promise<Raw[]> {
  const doc = xml.parse(await get(src.url));
  let items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
  if (!Array.isArray(items)) items = [items];
  return items.slice(0, 40).map((it: any) => {
    const link = typeof it.link === "object" ? (it.link["@_href"] ?? txt(it.link)) : txt(it.link);
    const pub = txt(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"]);
    const d = pub ? new Date(pub) : new Date();
    return {
      url: normUrl(link || txt(it.guid)),
      title: decode(txt(it.title)),
      standfirst: decode(txt(it.description ?? it.summary)).slice(0, 400),
      published: isNaN(d.getTime()) ? nowIso() : d.toISOString(),
    };
  }).filter((r: Raw) => r.url && r.title);
}

async function fetchLfc(src: Source, known: Set<string>): Promise<Raw[]> {
  const html = await get(src.url);
  const paths = [...new Set([...html.matchAll(/href="(\/news\/[a-z0-9-]+)"/g)].map((m) => m[1]))];
  const fresh = paths.map((p) => `https://www.liverpoolfc.com${p}`).filter((u) => !known.has(u)).slice(0, 15);
  const out: Raw[] = [];
  for (const url of fresh) {
    try {
      const a = await get(url);
      const meta = (p: string) => decode(a.match(new RegExp(`<meta (?:property|name)="${p}" content="([^"]*)"`))?.[1] ?? "");
      const title = meta("og:title").replace(/ - Liverpool FC$/, "");
      const pub = a.match(/"datePublished":"([^"]+)"/)?.[1];
      if (title) out.push({ url, title, standfirst: meta("og:description").slice(0, 400), published: pub ? new Date(pub).toISOString() : nowIso() });
    } catch (e) { console.error("lfc article failed", url, String(e)); }
  }
  return out;
}

// Fixtures from the club's own fixtures page (schema.org SportsEvent JSON-LD). Refreshed every 3 hours.
function competitionFromUrl(u: string): string | undefined {
  if (/premier-league/.test(u)) return "Premier League";
  if (/champions-league/.test(u)) return "Champions League";
  if (/carabao|league-cup|efl-cup/.test(u)) return "Carabao Cup";
  if (/fa-cup/.test(u)) return "FA Cup";
  return undefined;
}
async function fetchFixtures(): Promise<Fixture[]> {
  const html = await get("https://www.liverpoolfc.com/matches/mens-team/fixtures", 30000);
  const events: Fixture[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let j: any; try { j = JSON.parse(m[1]); } catch { continue; }
    const lists = Array.isArray(j) ? j : [j];
    for (const l of lists) for (const e of l?.itemListElement ?? []) {
      if (e?.["@type"] !== "SportsEvent" || !e.startDate) continue;
      events.push({ start: new Date(e.startDate).toISOString(), home: e.homeTeam?.name ?? "", away: e.awayTeam?.name ?? "", venue: e.location?.name ?? "", url: e.url ?? "", competition: competitionFromUrl(e.url ?? "") });
    }
  }
  const soon = Date.now() - 3 * 36e5; // keep a match visible while it is being played
  return events.filter((e) => new Date(e.start).getTime() > soon).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 8);
}

// ---------- LLM ----------
const SYSTEM = `You are the filter and sub-editor for a private Liverpool FC news wire read by one supporter, an engineer who wants reliable news with no fluff.

Every item comes from a trusted outlet (liverpoolfc.com, Sky Sports, BBC Sport, Liverpool Echo, The Athletic). Your job is to decide what is worth his attention and summarise it.

KEEP (status kept) only items that report something new and concrete about Liverpool FC:
- injuries, fitness, availability, suspensions, confirmed team news
- results and final scores of Liverpool first-team matches, and competitive fixture or kick-off changes
- transfers and contracts that are confirmed, or reported first-hand by the outlet's own named journalist (e.g. Ornstein, Pearce, the Echo's own reporting). Include contract talks status.
- manager, coaching and executive appointments or departures
- ownership, investment, accounts, commercial deals, stadium, Premier League or UEFA financial regulation that affects Liverpool or a direct rival's standing
- substantive manager press conference news (a decision, an injury update, a stated plan), not general musings
- loanee news only if material (a loan ended, a serious injury, a recall)

DROP (status dropped):
- opinion, analysis, columns, "talking points", "what we spotted", "X things we learned", player ratings, predictions, verdicts
- fan reaction, social media reaction, pundit quotes that contain no new fact
- relayed rumour: anything attributing the claim to another outlet (papers round-up, "according to reports in Spain", Paper Talk, gossip columns) or to an unnamed source without the outlet's own reporting
- clickbait or vague headlines whose body adds no concrete fact
- how-to-watch, TV listings, tickets, membership offers, retail and kit promotions, FPL, quizzes, galleries, videos, podcasts, betting, previews that repeat known team news
- history, nostalgia, former players unless a current club matter (a former player's retirement is dropped)
- items not about Liverpool FC (other clubs' news), unless it materially changes Liverpool's competition, e.g. a rival's points deduction
- women's and academy items unless material (a result, a senior call-up, a serious injury)

For KEPT items:
- summary: one or two short sentences, UK English, factual, no hype. The first sentence states the news itself, like a wire headline, then attributes it at the end: "Isak and Gakpo are out of Sunday's game against Manchester City, the club confirms." Never open with the outlet's name or describe the article ("The Echo provides an update", "X rounds up", "Iraola discusses"). Never use em dashes or en dashes; use commas or full stops. No adjectives like huge, massive, stunning, blow.
- material: true only for things worth a phone notification: a first-choice player ruled out for weeks or more, a signing or sale agreed or confirmed, a new contract signed or talks collapsed, a manager or director change, an ownership or regulation development, a postponement. Otherwise false. Be strict.
- cluster: if it reports the same story as one of the RECENT STORIES listed, give that story's id. If it reports the same story as another NEW ITEM in this batch, give that item's id. Otherwise "new".

Duplicates: never drop an item just because another outlet or an earlier item covers the same story. Keep it and set cluster to that story's id, so it appears as a corroborating link under one card. Only drop it if it would be dropped on its own merits.

For DROPPED items give a 3 to 6 word reason, an empty summary, category none and the drop_kind that best fits. For KEPT items drop_kind is none.

Return exactly one result per input item.`;

// Structured outputs: standard JSON Schema, built per batch so ids and cluster targets are constrained to valid values.
const DROP_KINDS = ["opinion", "reaction", "preview", "rumour", "feature", "promo", "off-topic", "thin", "other", "none"];
const CATEGORIES = ["injury", "team-news", "result", "transfer", "contract", "staff", "business", "regulation", "other", "none"];
function buildSchema(batchIds: string[], clusterIds: string[]) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        minItems: batchIds.length,
        maxItems: batchIds.length,
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: batchIds, description: "The input item's id." },
            status: { type: "string", enum: ["kept", "dropped"] },
            category: { type: "string", enum: CATEGORIES, description: "For kept items the news category; for dropped items use none." },
            summary: { type: "string", description: "Kept: one or two factual sentences, UK English, stating the news first and attributing it at the end. Dropped: empty string." },
            reason: { type: "string", description: "Dropped: 3 to 6 word reason. Kept: empty string." },
            material: { type: "boolean", description: "True only if worth a phone notification. Always false for dropped items." },
            drop_kind: { type: "string", enum: DROP_KINDS, description: "Dropped: opinion (analysis, columns, predictions), reaction (quotes or social chatter with no new fact), preview (match previews, listings, how to watch), rumour (relayed from other outlets or unnamed sources), feature (history, interviews, nostalgia), promo (tickets, retail, FPL, video, podcasts), off-topic (not about Liverpool), thin (vague, duplicate, live blog), other. Kept: none." },
            cluster: { type: "string", enum: ["new", ...clusterIds], description: "Id of the RECENT STORY or other NEW ITEM reporting the same story, else new." },
          },
          required: ["id", "status", "category", "summary", "reason", "material", "drop_kind", "cluster"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}

// Structured outputs via responseMimeType + responseJsonSchema. The documented responseFormat.text form was
// rejected by the live API on 10 Oct 2026 ("Invalid value at generation_config.response_format.text.mime_type").
async function callGemini(prompt: string, schema: object, withThinking: boolean): Promise<Response> {
  const generationConfig: any = { temperature: 0.2, maxOutputTokens: 8000, responseMimeType: "application/json", responseJsonSchema: schema };
  if (withThinking && THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
  const base = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  return fetch(`${base}/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY!, "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
    signal: AbortSignal.timeout(90000),
  });
}

async function classify(batch: Item[], recent: Item[], state: State): Promise<boolean> {
  if (!env.GEMINI_API_KEY) { console.log("no GEMINI_API_KEY, leaving items pending"); return false; }
  const day = ukParts().date;
  const u = (state.usage[day] ??= { in: 0, out: 0, calls: 0 });
  if (u.in + u.out > DAILY_TOKEN_CAP) { console.log("daily token cap reached, leaving items pending"); return false; }

  const recentList = recent.slice(0, 30).map((r) => `${r.cluster}: ${r.title}`).join("\n") || "(none)";
  const itemsText = batch.map((b) => `id: ${b.id}\nsource: ${b.source}\npublished: ${b.published}\nheadline: ${b.title}\nstandfirst: ${b.standfirst}`).join("\n\n");
  const prompt = `RECENT STORIES (id: headline):\n${recentList}\n\nNEW ITEMS:\n\n${itemsText}`;

  const recentIdList = [...new Set(recent.slice(0, 30).map((x) => x.cluster!).filter(Boolean))];
  const schema = buildSchema(batch.map((b) => b.id), [...new Set([...recentIdList, ...batch.map((b) => b.id)])]);
  let r: Response;
  try {
    r = await callGemini(prompt, schema, true);
    if (r.status === 400 && THINKING_LEVEL) { // thinking level not accepted by a swapped-in model: retry once without it
      console.error("gemini 400, retrying without thinkingConfig:", (await r.text()).slice(0, 300));
      r = await callGemini(prompt, schema, false);
    }
    for (const wait of [5000, 20000]) { // transient overload or rate limit: back off twice, then leave for next run
      if (r.status !== 503 && r.status !== 429 && r.status !== 500) break;
      console.error(`gemini ${r.status}, retrying in ${wait / 1000}s`); await r.text();
      await Bun.sleep(wait); r = await callGemini(prompt, schema, true);
    }
  } catch (e) { console.error("gemini request failed", String(e)); state.modelError = `${fmtTime(nowIso())}: ${String(e).slice(0, 200)}`; return false; }
  if (!r.ok) { const t = (await r.text()).slice(0, 300); console.error("gemini error", r.status, t); state.modelError = `${fmtTime(nowIso())}: HTTP ${r.status} ${t}`; return false; }
  const j: any = await r.json();
  const um = j.usageMetadata ?? {};
  u.in += um.promptTokenCount ?? 0; u.out += (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0); u.calls += 1;
  const text = (j.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
  let res: any[] = [];
  try { res = JSON.parse(text).results ?? []; }
  catch { console.error("gemini returned unparseable JSON, finishReason:", j.candidates?.[0]?.finishReason, text.slice(0, 300)); state.modelError = `${fmtTime(nowIso())}: unparseable JSON (${j.candidates?.[0]?.finishReason})`; return false; }
  const batchIds = new Set(batch.map((b) => b.id));
  const seen = new Set<string>();
  res = res.filter((x) => batchIds.has(x.id) && !seen.has(x.id) && seen.add(x.id)); // schema guarantees shape, not uniqueness
  state.modelError = undefined;
  const recentIds = new Set([...recent.map((r) => r.cluster), ...batch.map((b) => b.id)]);
  for (const it of batch) {
    const d = res.find((x) => x.id === it.id);
    if (!d) continue; // stays pending, retried next run
    it.status = d.status === "kept" ? "kept" : "dropped";
    it.category = it.status === "kept" && d.category !== "none" ? d.category : it.status === "kept" ? "other" : undefined;
    it.reason = it.status === "dropped" ? d.reason : undefined;
    it.dropKind = it.status === "dropped" && d.drop_kind !== "none" ? d.drop_kind : undefined;
    it.summary = (it.status === "kept" ? d.summary || "" : "").replace(/\s*[–—]\s*/g, ", ");
    it.material = !!d.material && it.status === "kept";
    // a pointer to another new item resolves to that item's own cluster, so chains collapse to one card
    const target = d.cluster !== "new" && d.cluster !== it.id && recentIds.has(d.cluster) ? d.cluster : it.id;
    it.cluster = batch.find((b) => b.id === target)?.cluster ?? target;
    if (it.status === "kept") recent.unshift(it);
  }
  const byId = new Map(batch.map((b) => [b.id, b]));
  for (const it of batch) { // collapse chains such as B -> A -> recent story X
    for (let hops = 0; hops < 5; hops++) { const nxt = byId.get(it.cluster!); if (!nxt || nxt === it || nxt.cluster === it.cluster) break; it.cluster = nxt.cluster; }
  }
  return true;
}

// ---------- push ----------
// Web push to every device that turned alerts on in the wire (subscriptions live in subs.json, written by the web service).
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
async function notify(title: string, body: string, url = "/", tag?: string, urgency: "high" | "low" = "high") {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) { console.log("no VAPID keys, skipping push"); return; }
  let subs: Sub[] = [];
  try { subs = JSON.parse((await readText("subs.json")) || "[]"); } catch (e) { console.error("subs read failed", String(e)); return; }
  if (!subs.length) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT || env.WIRE_URL || "https://wire-web-production-7556.up.railway.app", env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const gone = new Set<string>();
  for (const sub of subs) {
    try {
      const d = webpush.generateRequestDetails(sub, JSON.stringify({ title, body, url, tag }), { TTL: 6 * 3600, urgency });
      const r = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body, signal: AbortSignal.timeout(15000) });
      if (r.status === 404 || r.status === 410) gone.add(sub.endpoint); // device unsubscribed or app removed
      else if (r.status >= 300) console.error("push rejected", r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.error("push failed", String(e)); }
  }
  if (gone.size) {
    try { const fresh: Sub[] = JSON.parse((await readText("subs.json")) || "[]"); await writeText("subs.json", JSON.stringify(fresh.filter((x) => !gone.has(x.endpoint))), "application/json"); }
    catch (e) { console.error("subs cleanup failed", String(e)); }
  }
}
const CAT_LABEL: Record<string, string> = { injury: "Injury", "team-news": "Team news", result: "Result", transfer: "Transfer", contract: "Contract", staff: "Staff", business: "Business", regulation: "Regulation", other: "Club news" };
const storyUrl = (it: Item) => `/#s-${it.cluster || it.id}`;

// ---------- main ----------
async function main() {
  const state: State = JSON.parse((await readText("state.json")) || "null") ?? { items: [], health: {}, usage: {}, pushes: {} };
  state.pushes ??= {};
  const known = new Set(state.items.map((i) => i.url));
  const cutoff = Date.now() - RETAIN_DAYS * 864e5;
  let added = 0;

  // 1. fetch
  for (const src of SOURCES) {
    const h = (state.health[src.key] ??= { fails: 0 });
    try {
      const raws = src.kind === "rss" ? await fetchRss(src) : await fetchLfc(src, known);
      h.lastOk = nowIso(); h.lastCount = raws.length;
      if (h.fails >= 4 && h.alerted) await notify(`${src.name} is back`, "The wire is reading it again.", "/status", `src-${src.key}`, "low");
      h.fails = 0; h.alerted = false;
      for (const r of raws) {
        if (known.has(r.url) || Date.now() - new Date(r.published).getTime() > INGEST_MAX_AGE_H * 36e5) continue;
        known.add(r.url); added++;
        state.items.push({ id: hashId(r.url), url: r.url, source: src.name, title: r.title, standfirst: r.standfirst, published: r.published, fetched: nowIso(), status: "pending" });
      }
    } catch (e) {
      h.fails++; h.lastError = String(e).slice(0, 200); h.lastErrorAt = nowIso();
      console.error(`source ${src.key} failed`, h.lastError);
      if (h.fails >= 4 && !h.alerted) { await notify(`${src.name} is failing`, `${h.fails} runs in a row. Last error: ${h.lastError}`, "/status", `src-${src.key}`, "low"); h.alerted = true; }
    }
  }

  // 1b. fixtures, every 3 hours; a failure keeps the previous list
  if (!state.fixtures || Date.now() - new Date(state.fixtures.fetchedAt).getTime() > 3 * 36e5) {
    try { const events = await fetchFixtures(); if (events.length) state.fixtures = { fetchedAt: nowIso(), events }; }
    catch (e) { console.error("fixtures failed", String(e)); }
  }

  // 2. classify pending (newest first, batches of 20, cap 3 batches per run)
  const pending = state.items.filter((i) => i.status === "pending").sort((a, b) => b.published.localeCompare(a.published));
  const recent = state.items.filter((i) => i.status === "kept" && Date.now() - new Date(i.published).getTime() < 48 * 36e5).sort((a, b) => b.published.localeCompare(a.published));
  for (let i = 0; i < Math.min(pending.length, 60); i += 20) {
    const ok = await classify(pending.slice(i, i + 20), recent, state);
    if (!ok) break;
  }

  // 3. push material items (one push per cluster), respecting quiet hours and a daily cap
  const uk = ukParts();
  const quiet = QUIET_START > QUIET_END ? uk.hour >= QUIET_START || uk.hour < QUIET_END : uk.hour >= QUIET_START && uk.hour < QUIET_END;
  if (!quiet) {
    const clustersPushed = new Set(state.items.filter((i) => i.pushed).map((i) => i.cluster));
    const due = state.items.filter((i) => i.material && !i.pushed && !clustersPushed.has(i.cluster) && Date.now() - new Date(i.published).getTime() < 12 * 36e5);
    const sent = (state.pushes[uk.date] ??= 0);
    const room = Math.max(0, MAX_PUSH_PER_DAY - sent);
    if (due.length > 0 && room > 0) {
      if (due.length <= Math.min(room, 2)) {
        for (const it of due) {
          const cluster = state.items.filter((x) => x.cluster === it.cluster && x.status === "kept");
          const official = cluster.some((x) => x.source === "liverpoolfc.com");
          await notify(`${CAT_LABEL[it.category || "other"] ?? "Club news"}${official ? " · Club confirmed" : ""}`, it.summary || it.title, storyUrl(it), it.cluster);
        }
      } else {
        await notify(`${due.length} new stories`, due.slice(0, 4).map((i) => i.summary || i.title).join("\n"), "/", "digest");
      }
      state.pushes[uk.date] = sent + (due.length <= Math.min(room, 2) ? due.length : 1);
    }
    for (const it of due) { it.pushed = true; state.items.filter((x) => x.cluster === it.cluster).forEach((x) => (x.pushed = true)); }
  }

  // 4. retain and save (one bucket write per run)
  state.items = state.items.filter((i) => new Date(i.published).getTime() >= cutoff);
  for (const k of Object.keys(state.usage)) if (k < new Date(cutoff).toISOString().slice(0, 10)) delete state.usage[k];
  for (const k of Object.keys(state.pushes)) if (k < new Date(cutoff).toISOString().slice(0, 10)) delete state.pushes[k];
  state.lastRun = nowIso();
  await writeText("state.json", JSON.stringify(state), "application/json");
  console.log(`run done: +${added} new, ${state.items.filter((i) => i.status === "pending").length} pending, ${state.items.filter((i) => i.status === "kept").length} kept`);
}

await main();
