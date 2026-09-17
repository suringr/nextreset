/**
 * Render verified values into the published site.
 *
 * The tracker pages are hand-authored shells: they ship "--:--:--" where the value belongs and fill
 * it in with JavaScript. Crawlers, and readers without JavaScript, therefore see nothing NextReset
 * actually knows. This step writes the verified facts into the HTML at build time.
 *
 *   refresh:data  ->  export:site (public/ -> dist/)  ->  render:pages (this)  ->  publish dist/
 *
 * It only ever writes into dist/. The authored pages under public/ stay as they are, so a build
 * produces no diff against the repository and rolling this back is one line in build:site.
 *
 * It reads only files the build already has (dist/data/*.json, written by refresh:data). No network,
 * no browser, no model: rendering costs nothing.
 *
 * app.js keeps working as progressive enhancement. It overwrites the same nodes on load, so an exact
 * instant still becomes a live countdown in the browser; the rendered HTML is what everyone else sees.
 */
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { IndexDecision, NOINDEX_TAG, indexStateFor, staticPageDecision } from "./indexing";
import { blocksFor as dataBlocksFor, loadKnowledge, renderBlocks } from "./render-data-blocks";
import { CardGroup, renderHomeHtml } from "./render-home";
import { SitemapEntry, SitemapInput, renderSitemap } from "./render-sitemap";
import { replaceSlot } from "./render-slots";
import { VersionedAssets, versionAssets } from "./version-assets";

/** The published tracker shape (see scripts/types.ts). Read defensively: this is file input. */
export interface TrackerData {
    provider_id?: string;
    game?: string;
    type?: string;
    title?: string;
    status?: string;
    nextEventUtc?: string | null;
    fetched_at_utc?: string;
    last_success_at_utc?: string;
    source_url?: string;
    confidence?: string;
    notes?: string;
    reason?: string;
    reason_code?: string;
    precision?: string;
    explanation?: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Publishers behind the source hosts we actually use. A host we do not know shows as its hostname. */
const PUBLISHERS: ReadonlyArray<readonly [string, string]> = [
    ["riotgames.com", "Riot Games"],
    ["leagueoflegends.com", "Riot Games"],
    ["playvalorant.com", "Riot Games"],
    ["steampowered.com", "Steam"],
    ["akamaihd.net", "Steam"],
    ["steamcommunity.com", "Steam"],
    ["callofduty.com", "Call of Duty"],
    ["hoyoverse.com", "HoYoverse"],
    ["mojang.com", "Mojang"],
    ["minecraft.net", "Mojang"],
    ["rockstargames.com", "Rockstar Games"],
    ["roblox.com", "Roblox"],
    ["ea.com", "EA"],
    ["epicgames.com", "Epic Games"],
    ["fortnite.com", "Epic Games"]
];

/**
 * Repairs values a V1 provider concatenated without spaces, such as Red Dead's
 * "Red Dead OnlineSeptember 1, 2026Distill Your Best Swill…".
 *
 * Deliberately narrow: a space is inserted only before a month name that follows a letter, and after a
 * year that runs straight into a word. Anything else is left exactly as published, so a legitimate
 * value like "Patch 26.19" or "EA SPORTS FC 26 version 1.6.5" is untouched.
 */
export function tidyNotes(value: string): string {
    const months = "January|February|March|April|May|June|July|August|September|October|November|December";
    return value
        .replace(new RegExp(`([a-z])(${months})\\b`, "g"), "$1 $2")
        .replace(/(\d{4})([A-Z])/g, "$1 $2");
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function utcParts(iso: string): { y: number; m: number; d: number; hh: string; mm: string } | undefined {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return undefined;
    return {
        y: date.getUTCFullYear(),
        m: date.getUTCMonth(),
        d: date.getUTCDate(),
        hh: String(date.getUTCHours()).padStart(2, "0"),
        mm: String(date.getUTCMinutes()).padStart(2, "0")
    };
}

/** "2026-09-23T00:00:00.000Z" -> "September 23, 2026". Used for values the source states as a date. */
export function formatDate(iso: string): string {
    const p = utcParts(iso);
    return p ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : "";
}

/** "2026-09-09T22:51:08.000Z" -> "September 9, 2026 at 22:51 UTC". Only for instants known to the second. */
export function formatDateTime(iso: string): string {
    const p = utcParts(iso);
    return p ? `${MONTHS[p.m]} ${p.d}, ${p.y} at ${p.hh}:${p.mm} UTC` : "";
}

/** The publisher behind a source link, for link text a reader recognises. */
export function sourceName(url: string): string {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "Official source";
    }
    for (const [domain, name] of PUBLISHERS) {
        if (host === domain || host.endsWith(`.${domain}`)) return name;
    }
    return host;
}

/**
 * What the page should say about this tracker's state.
 *
 * A raw provider message is never published: only a sentence the pipeline itself produced for
 * visitors (which carries `reason_code`) is shown. V1 providers have no such vocabulary yet, so
 * their failures are described generically rather than quoted.
 */
/**
 * Whether the pipeline stands behind a value at all.
 *
 * Four ways it says no, and they mean the same thing to a reader: no file, no value in it, a status of
 * `unavailable` or the legacy `fallback`, or a confidence of `none` — which is how the pipeline
 * withdraws a value it has published before. app.js has always used all four (isDataUnavailable); the
 * homepage cards use all four; the tracker pages used two, so a withdrawn value was rendered as a fact
 * by the build and replaced with "Data unavailable" a moment later by the browser.
 */
export function hasVerifiedValue(data: TrackerData | undefined): data is TrackerData & { nextEventUtc: string } {
    if (!data || !data.nextEventUtc) return false;
    // A published file is input, not a contract. A timestamp that cannot be parsed formats as an empty
    // string, so without this the page would publish a blank value and ask to be indexed on it.
    if (!Number.isFinite(Date.parse(data.nextEventUtc))) return false;
    return data.confidence !== "none" && data.status !== "unavailable" && data.status !== "fallback";
}

/** The same question asked the other way round, for the places that read better in the negative. */
export function hasNoVerifiedValue(data: TrackerData | undefined): boolean {
    return !hasVerifiedValue(data);
}

export function stateLine(data: TrackerData | undefined): string {
    if (!hasVerifiedValue(data)) {
        const vetted = data?.reason_code ? data.explanation ?? data.reason : undefined;
        return vetted ?? "No verified value is available right now";
    }
    if (data.status === "stale") {
        const vetted = data.reason_code ? data.reason : undefined;
        return vetted ?? "Showing the last verified value; the official source could not be checked";
    }
    return "Verified from the official source";
}

const DAY_MS = 86_400_000;

/** Topics that answer "when is the next …": their value is only an answer while it is still ahead. */
export function isFutureFacing(type: string | undefined): boolean {
    return !!type && (type.startsWith("next-") || type.includes("reset"));
}

/**
 * Whether a future-facing tracker's date has stopped being an answer.
 *
 * Publishing a date that has already passed as though it were still upcoming is the worst thing a
 * countdown can do, and it is what Fortnite did for three months. A date that has only just passed
 * while the data is fresh is a normal moment in the cycle — the next value arrives with the next
 * refresh — so only a stale or long-passed date counts as unanswered.
 */
export function isUnanswered(data: TrackerData, now: Date): boolean {
    if (!data.nextEventUtc || !isFutureFacing(data.type)) return false;
    const at = Date.parse(data.nextEventUtc);
    if (!Number.isFinite(at)) return false;
    // A date-only value is announced for a day, not an instant: midnight is only where it had to be
    // stored. It stays the answer until that whole UTC day is over, exactly as the pipeline treats it
    // (see upcomingUntil in scripts/v2/knowledge.ts). The same applies when precision is not stated,
    // because then we have not been told it is an instant either.
    const over = at + (data.precision === "exact" ? 0 : DAY_MS);
    if (over >= now.getTime()) return false;
    return data.status === "stale" || now.getTime() - over > DAY_MS;
}

/** Shown when a future-facing tracker has no date anyone has published yet. */
export const NO_DATE_NOTE = "We have not found a verified official date. NextReset will show it as soon as it can be verified from an official source.";

export interface RenderedBlocks {
    label: string;
    value: string;
    valueClass: string;
    notes?: string;
    source?: { url: string; name: string };
    confidence?: string;
    /** When the source last confirmed this value (last_success_at_utc). */
    lastVerified?: string;
    /** When we last tried, successfully or not (fetched_at_utc). */
    lastChecked?: string;
    precision?: string;
    state: string;
}

/** Everything the page needs, derived from the published tracker data alone. */
export function blocksFor(data: TrackerData | undefined, now: Date = new Date()): RenderedBlocks {
    const state = stateLine(data);
    if (!hasVerifiedValue(data)) {
        return {
            label: "Status", value: "Data unavailable", valueClass: "countdown-value unavailable", notes: state, state,
            lastVerified: data?.last_success_at_utc ? formatDateTime(data.last_success_at_utc) : undefined,
            lastChecked: data?.fetched_at_utc ? formatDateTime(data.fetched_at_utc) : undefined
        };
    }

    if (isUnanswered(data, now)) {
        // The page keeps its question. The honest answer is that no official date has been published.
        // The stored confidence described the expired value, not this answer, so it is not carried over.
        return {
            label: "Status",
            value: "No official date announced",
            valueClass: "countdown-value unavailable",
            notes: NO_DATE_NOTE,
            source: data.source_url ? { url: data.source_url, name: sourceName(data.source_url) } : undefined,
            confidence: undefined,
            lastVerified: data.last_success_at_utc ? formatDateTime(data.last_success_at_utc) : undefined,
            lastChecked: data.fetched_at_utc ? formatDateTime(data.fetched_at_utc) : undefined,
            state: "No verified official date"
        };
    }

    const stale = data.status === "stale";
    // A time is published only where the pipeline states the instant is exact. A date-only value, or one
    // whose precision is not stated at all (the V1 providers), is shown as a date: midnight UTC is a
    // storage artefact, not an announced time, and must never be presented as one.
    const exact = data.precision === "exact";
    const value = exact ? formatDateTime(data.nextEventUtc) : formatDate(data.nextEventUtc);
    const label = exact ? "Official date and time" : "Official date";

    return {
        label,
        value,
        valueClass: stale ? "countdown-value stale" : "countdown-value",
        notes: data.notes,
        source: data.source_url ? { url: data.source_url, name: sourceName(data.source_url) } : undefined,
        confidence: data.confidence,
        lastVerified: data.last_success_at_utc ? formatDateTime(data.last_success_at_utc) : undefined,
        lastChecked: data.fetched_at_utc ? formatDateTime(data.fetched_at_utc) : undefined,
        precision: data.precision === "day" ? "Date only, no time announced" : data.precision === "exact" ? "Exact time" : undefined,
        state
    };
}

/**
 * Puts a tag into the head, after the canonical link.
 *
 * The canonical is the one line every page has exactly once and no page can lose without failing its
 * own test, which makes it the anchor. Matched as a pattern rather than a literal, because each page's
 * canonical names that page.
 */
function insertAfterCanonical(html: string, tag: string, page: string): string {
    const canonical = /<link rel="canonical"[^>]*>/g;
    const found = html.match(canonical);
    if (!found || found.length !== 1) throw new Error(`${page}: expected exactly one canonical link, found ${found?.length ?? 0}`);
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    return html.replace(canonical, match => `${match}${eol}  ${tag}`);
}

/**
 * One verification row, indented to sit where the slot it replaces sat.
 *
 * The indentation is taken from the page rather than hardcoded, because the row's own first line is
 * already indented by the document: only the lines this adds need spacing of their own.
 */
function infoRow(indent: string, eol: string, label: string, value: string): string {
    return [
        `<div class="info-row">`,
        `${indent}  <span class="info-label">${label}</span>`,
        `${indent}  ${value}`,
        `${indent}</div>`
    ].join(eol);
}

/** Writes the verified facts into one tracker page. Pure: takes HTML and data, returns HTML. */
export function renderTrackerHtml(html: string, data: TrackerData | undefined, page = "page", now: Date = new Date(), blocksHtml = ""): string {
    const b = blocksFor(data, now);

    // A page that cannot answer its question is honest but thin, and asking to be indexed on it is
    // asking to be judged on the page that says the least. It is still crawled, and its links still
    // followed to the pages that do answer something.
    if (indexStateFor(data, now).state === "noindex") {
        html = insertAfterCanonical(html, NOINDEX_TAG, page);
    }

    // The authored pages are stored with CRLF and checked out with LF in CI. Everything written here
    // uses the line ending the file already has, so a rendered page keeps the endings it came with.
    const eol = html.includes("\r\n") ? "\r\n" : "\n";

    let out = replaceSlot(html, "answer-label", () => `<div class="countdown-label">${escapeHtml(b.label)}</div>`, page);
    out = replaceSlot(out, "answer-value", () => `<div class="${b.valueClass}">${escapeHtml(b.value)}</div>`, page);

    out = replaceSlot(out, "source", () => b.source
        ? `<span class="info-value" id="source"><a href="${escapeHtml(b.source.url)}" target="_blank" rel="noopener">${escapeHtml(b.source.name)}</a></span>`
        : `<span class="info-value" id="source">Unavailable</span>`, page);

    out = replaceSlot(out, "confidence", () => b.confidence
        ? `<span id="confidence" class="confidence confidence-${escapeHtml(b.confidence)}">${escapeHtml(b.confidence)}</span>`
        : `<span id="confidence" class="confidence confidence-none">none</span>`, page);

    // Two different facts, deliberately kept apart: when the source last confirmed the value, and when
    // we last tried. app.js rewrites #last-updated from fetched_at_utc on load, so only the "checked"
    // row carries that id — a failed refresh can never relabel a months-old value as verified just now.
    out = replaceSlot(out, "meta-rows", element => {
        const indent = element.indent;
        const rows: string[] = [
            infoRow(indent, eol, "Last Verified", `<span class="info-value" id="last-verified">${escapeHtml(b.lastVerified ?? "Never")}</span>`),
            infoRow(indent, eol, "Last Checked", `<span class="info-value" id="last-updated">${escapeHtml(b.lastChecked ?? "Never")}</span>`)
        ];
        if (b.precision) {
            rows.push(infoRow(indent, eol, "Precision", `<span class="info-value">${escapeHtml(b.precision)}</span>`));
        }
        rows.push(infoRow(indent, eol, "Status", `<span class="info-value" id="tracker-status">${escapeHtml(b.state)}</span>`));
        return rows.join(eol + indent);
    }, page);

    out = replaceSlot(out, "notes", element => b.notes
        ? `<div id="notes" class="notes">${escapeHtml(tidyNotes(b.notes))}</div>`
        : element.source, page);

    // The data slot stays empty unless this game's knowledge supports a block: an empty section is
    // worse than no section.
    //
    // The blocks are built with "\n" whatever the page uses, so they are rewritten in the page's own
    // line endings on the way in. A CRLF page carrying LF-only rows renders fine and diffs terribly.
    const blocks = blocksHtml.replace(/\r\n/g, "\n").split("\n").join(eol);
    out = replaceSlot(out, "verified-data", element => blocks
        ? `<div id="verified-data">${eol}${blocks}${eol}${element.indent}</div>`
        : element.source, page);

    return out;
}

/**
 * `data-game` / `data-type` on the page's hidden container say which tracker it shows.
 *
 * The markup is parsed rather than pattern-matched, so attribute order, quote style, spacing around
 * `=` and any additional attributes are all irrelevant. An ordinary HTML edit must never turn a
 * tracker page into one we quietly skip, because skipping it would publish its placeholders.
 * A container that exists but cannot be read is template drift, so it fails the build.
 */
export function trackerOf(html: string, page = "page"): { game: string; type: string } | undefined {
    const container = cheerio.load(html)("#countdown-container");
    if (container.length === 0) return undefined;
    const game = container.attr("data-game");
    const type = container.attr("data-type");
    if (!game || !type) throw new Error(`${page}: tracker container has no readable data-game/data-type`);
    return { game, type };
}

function htmlFilesIn(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...htmlFilesIn(full));
        else if (entry.name.endsWith(".html")) out.push(full);
    }
    return out;
}

export interface RenderSummary {
    rendered: Array<{ page: string; game: string; type: string; status: string; value: string; blocks?: number }>;
    /** Pages with no data file: rendered as unavailable rather than left showing a placeholder. */
    missingData: string[];
    /** Pages with no tracker container (home, about, privacy). */
    skipped: number;
    /** How the homepage's cards were grouped, when the homepage was rendered. */
    home?: Record<CardGroup, number>;
    /** The version stamped on each asset, so a year-long cache cannot hold an old script. */
    assets: VersionedAssets;
    /** What went into sitemap.xml, and which of those pages could be dated. */
    sitemap: SitemapEntry[];
    /** Why each page is or is not in the index. */
    indexing: Array<{ page: string; state: IndexDecision["state"]; reason: string }>;
}

function readData(dataDir: string, game: string, type: string): TrackerData | undefined {
    const file = path.join(dataDir, `${game}.${type}.json`);
    if (!fs.existsSync(file)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as TrackerData;
    } catch {
        return undefined;
    }
}

/** Renders every tracker page in `distDir` in place. Throws on template drift; never touches public/. */
export function renderSite(distDir: string, now: Date = new Date(), root: string = path.dirname(distDir)): RenderSummary {
    const summary: RenderSummary = { rendered: [], missingData: [], skipped: 0, assets: { versions: {}, pages: 0, missing: [] }, sitemap: [], indexing: [] };
    const dataDir = path.join(distDir, "data");
    const readable = (iso: string, precision?: string) => (precision === "exact" ? formatDateTime(iso) : formatDate(iso));
    const pages = htmlFilesIn(distDir);
    const pagesForSitemap: SitemapInput[] = [];

    for (const file of pages) {
        const html = fs.readFileSync(file, "utf8");
        const page = path.relative(distDir, file).replace(/\\/g, "/");
        const tracker = trackerOf(html, page);
        if (!tracker) {
            const decision = staticPageDecision(html);
            summary.indexing.push({ page, ...decision });
            pagesForSitemap.push({ page, tracker, listed: decision.state === "index" });
            // The homepage has no tracker of its own: it shows all of them. Drift there is not survivable
            // — publishing twelve cards that say "Loading..." is what this milestone exists to end — so a
            // page that cannot be read throws rather than being skipped quietly.
            if (page === "index.html") {
                const home = renderHomeHtml(html, (game, type) => readData(dataDir, game, type), now);
                fs.writeFileSync(file, home.html, "utf8");
                summary.home = home.counts;
            } else {
                summary.skipped++;
            }
            continue;
        }
        const data = readData(dataDir, tracker.game, tracker.type);
        if (!data) summary.missingData.push(page);

        // A page we are asking Google not to index is not also submitted for indexing: asking for both
        // at once is the kind of contradiction that teaches a crawler to trust neither. Its facts are
        // still counted, because the homepage shows its card and is dated by everything on it.
        const decision = indexStateFor(data, now);
        summary.indexing.push({ page, ...decision });
        pagesForSitemap.push({ page, tracker, listed: decision.state === "index" });

        // Everything else this game has verified: schedules, history, regional times. Absent knowledge
        // (a plain clone) simply produces no blocks.
        //
        // Blocks are additive, so an unusable knowledge file costs this page its blocks and nothing
        // more. Template drift still throws, because that means the page itself would be published wrong.
        let blocksHtml = "";
        try {
            const knowledge = loadKnowledge(root, tracker.game);
            const currentKey = knowledge?.events?.find(e => e.topic === tracker.type && e.at === data?.nextEventUtc)?.key;
            // A page that is not publishing a value must not list upcoming dates below that headline.
            const headlineAnswered = hasVerifiedValue(data) && !isUnanswered(data, now);
            blocksHtml = renderBlocks(dataBlocksFor(knowledge, tracker.type, { format: readable, now, currentKey, headlineAnswered }));
        } catch (error) {
            console.warn(`  ⚠ ${page}: knowledge unusable, publishing without data blocks (${error instanceof Error ? error.message : String(error)})`);
        }

        const rendered = renderTrackerHtml(html, data, page, now, blocksHtml);
        fs.writeFileSync(file, rendered, "utf8");
        const blocks = blocksFor(data, now);
        summary.rendered.push({ page, game: tracker.game, type: tracker.type, status: data?.status ?? "no-data", value: blocks.value, blocks: blocksHtml ? blocksHtml.split("<h2>").length - 1 : 0 });
    }

    // The sitemap lists what was actually built, dated by each page's own facts.
    summary.sitemap = renderSitemap(distDir, root, pagesForSitemap);

    // Last, because it stamps the pages this step has just written: the scripts and stylesheets are
    // cached for a year, so their URLs have to change whenever their contents do.
    summary.assets = versionAssets(distDir, pages);
    return summary;
}

if (require.main === module) {
    const dist = path.join(process.cwd(), "dist");
    if (!fs.existsSync(dist)) {
        console.error("❌ No dist/ to render. Run export:site first.");
        process.exit(1);
    }
    const summary = renderSite(dist);
    for (const r of summary.rendered) console.log(`  ✓ ${r.page} — ${r.status}: ${r.value}${r.blocks ? ` (+${r.blocks} data block(s))` : ""}`);
    for (const p of summary.missingData) console.warn(`  ⚠ ${p}: no data file; published as unavailable`);
    if (summary.home) console.log(`  ✓ index.html — ${summary.home.upcoming} upcoming, ${summary.home.recent} recently updated, ${summary.home.unknown} unanswered`);
    for (const page of summary.indexing.filter(p => p.state === "noindex")) console.log(`  ⊘ ${page.page} — noindex: ${page.reason}`);
    console.log(`  ✓ sitemap.xml — ${summary.sitemap.length} URL(s), ${summary.sitemap.filter(e => e.lastmod).length} dated`);
    for (const [asset, version] of Object.entries(summary.assets.versions)) console.log(`  ✓ ${asset}?v=${version}`);
    for (const absent of summary.assets.missing) console.warn(`  ⚠ ${absent}: referenced but not in the build; left unversioned`);
    console.log(`✅ Rendered ${summary.rendered.length} tracker page(s); ${summary.skipped} page(s) have no tracker.`);
}
