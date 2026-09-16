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
import { blocksFor as dataBlocksFor, loadKnowledge, renderBlocks } from "./render-data-blocks";
import { CardGroup, renderHomeHtml } from "./render-home";
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
export function stateLine(data: TrackerData | undefined): string {
    if (!data || data.status === "unavailable" || !data.nextEventUtc) {
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
    if (!data || !data.nextEventUtc || data.status === "unavailable") {
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

/** One replacement that must match exactly once, so template drift fails loudly instead of silently. */
function replaceOnce(html: string, needle: string, replacement: string, page: string): string {
    // The authored pages are stored with CRLF. Match and write in the file's own line endings, so a
    // multi-line anchor is found and the rendered file keeps the endings it had.
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    const find = needle.split("\n").join(eol);
    const put = replacement.split("\n").join(eol);
    const count = html.split(find).length - 1;
    if (count !== 1) throw new Error(`${page}: expected exactly one ${JSON.stringify(needle.slice(0, 60))}, found ${count}`);
    return html.replace(find, () => put);
}

const PLACEHOLDER_LABEL = `<div class="countdown-label">Checking official sources...</div>`;
const PLACEHOLDER_VALUE = `<div class="countdown-value countdown-skeleton">--:--:--</div>`;
const PLACEHOLDER_SOURCE = `<span class="info-value" id="source">...</span>`;
const PLACEHOLDER_CONFIDENCE = `<span id="confidence" class="confidence">...</span>`;
const PLACEHOLDER_NOTES = `<div id="notes" class="notes" style="display: none;"></div>`;
const PLACEHOLDER_DATA = `<div id="verified-data"></div>`;
const PLACEHOLDER_UPDATED_ROW = `        <div class="info-row">
          <span class="info-label">Last Updated</span>
          <span class="info-value" id="last-updated">...</span>
        </div>`;

/** Writes the verified facts into one tracker page. Pure: takes HTML and data, returns HTML. */
export function renderTrackerHtml(html: string, data: TrackerData | undefined, page = "page", now: Date = new Date(), blocksHtml = ""): string {
    const b = blocksFor(data, now);

    let out = replaceOnce(html, PLACEHOLDER_LABEL, `<div class="countdown-label">${escapeHtml(b.label)}</div>`, page);
    out = replaceOnce(out, PLACEHOLDER_VALUE, `<div class="${b.valueClass}">${escapeHtml(b.value)}</div>`, page);

    out = replaceOnce(out, PLACEHOLDER_SOURCE, b.source
        ? `<span class="info-value" id="source"><a href="${escapeHtml(b.source.url)}" target="_blank" rel="noopener">${escapeHtml(b.source.name)}</a></span>`
        : `<span class="info-value" id="source">Unavailable</span>`, page);

    out = replaceOnce(out, PLACEHOLDER_CONFIDENCE, b.confidence
        ? `<span id="confidence" class="confidence confidence-${escapeHtml(b.confidence)}">${escapeHtml(b.confidence)}</span>`
        : `<span id="confidence" class="confidence confidence-none">none</span>`, page);

    // Two different facts, deliberately kept apart: when the source last confirmed the value, and when
    // we last tried. app.js rewrites #last-updated from fetched_at_utc on load, so only the "checked"
    // row carries that id — a failed refresh can never relabel a months-old value as verified just now.
    const rows: string[] = [
        `        <div class="info-row">
          <span class="info-label">Last Verified</span>
          <span class="info-value" id="last-verified">${escapeHtml(b.lastVerified ?? "Never")}</span>
        </div>`,
        `        <div class="info-row">
          <span class="info-label">Last Checked</span>
          <span class="info-value" id="last-updated">${escapeHtml(b.lastChecked ?? "Never")}</span>
        </div>`
    ];
    if (b.precision) {
        rows.push(`        <div class="info-row">
          <span class="info-label">Precision</span>
          <span class="info-value">${escapeHtml(b.precision)}</span>
        </div>`);
    }
    rows.push(`        <div class="info-row">
          <span class="info-label">Status</span>
          <span class="info-value" id="tracker-status">${escapeHtml(b.state)}</span>
        </div>`);
    out = replaceOnce(out, PLACEHOLDER_UPDATED_ROW, rows.join("\n"), page);

    out = replaceOnce(out, PLACEHOLDER_NOTES, b.notes
        ? `<div id="notes" class="notes">${escapeHtml(tidyNotes(b.notes))}</div>`
        : PLACEHOLDER_NOTES, page);

    // The data slot stays empty unless this game's knowledge supports a block: an empty section is
    // worse than no section.
    out = replaceOnce(out, PLACEHOLDER_DATA, blocksHtml
        ? `<div id="verified-data">\n${blocksHtml}\n      </div>`
        : PLACEHOLDER_DATA, page);

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
    const summary: RenderSummary = { rendered: [], missingData: [], skipped: 0, assets: { versions: {}, pages: 0, missing: [] } };
    const dataDir = path.join(distDir, "data");
    const readable = (iso: string, precision?: string) => (precision === "exact" ? formatDateTime(iso) : formatDate(iso));
    const pages = htmlFilesIn(distDir);

    for (const file of pages) {
        const html = fs.readFileSync(file, "utf8");
        const page = path.relative(distDir, file).replace(/\\/g, "/");
        const tracker = trackerOf(html, page);
        if (!tracker) {
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
            const headlineAnswered = !!data && data.status !== "unavailable" && !!data.nextEventUtc && !isUnanswered(data, now);
            blocksHtml = renderBlocks(dataBlocksFor(knowledge, tracker.type, { format: readable, now, currentKey, headlineAnswered }));
        } catch (error) {
            console.warn(`  ⚠ ${page}: knowledge unusable, publishing without data blocks (${error instanceof Error ? error.message : String(error)})`);
        }

        const rendered = renderTrackerHtml(html, data, page, now, blocksHtml);
        fs.writeFileSync(file, rendered, "utf8");
        const blocks = blocksFor(data, now);
        summary.rendered.push({ page, game: tracker.game, type: tracker.type, status: data?.status ?? "no-data", value: blocks.value, blocks: blocksHtml ? blocksHtml.split("<h2>").length - 1 : 0 });
    }

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
    for (const [asset, version] of Object.entries(summary.assets.versions)) console.log(`  ✓ ${asset}?v=${version}`);
    for (const absent of summary.assets.missing) console.warn(`  ⚠ ${absent}: referenced but not in the build; left unversioned`);
    console.log(`✅ Rendered ${summary.rendered.length} tracker page(s); ${summary.skipped} page(s) have no tracker.`);
}
