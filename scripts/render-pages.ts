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
import * as fs from "fs";
import * as path from "path";

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
    ["epicgames.com", "Epic Games"]
];

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

export interface RenderedBlocks {
    label: string;
    value: string;
    valueClass: string;
    notes?: string;
    source?: { url: string; name: string };
    confidence?: string;
    lastVerified?: string;
    precision?: string;
    state: string;
}

/** Everything the page needs, derived from the published tracker data alone. */
export function blocksFor(data: TrackerData | undefined): RenderedBlocks {
    const state = stateLine(data);
    if (!data || !data.nextEventUtc || data.status === "unavailable") {
        return { label: "Status", value: "Data unavailable", valueClass: "countdown-value unavailable", notes: state, state };
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
const PLACEHOLDER_UPDATED_ROW = `        <div class="info-row">
          <span class="info-label">Last Updated</span>
          <span class="info-value" id="last-updated">...</span>
        </div>`;

/** Writes the verified facts into one tracker page. Pure: takes HTML and data, returns HTML. */
export function renderTrackerHtml(html: string, data: TrackerData | undefined, page = "page"): string {
    const b = blocksFor(data);

    let out = replaceOnce(html, PLACEHOLDER_LABEL, `<div class="countdown-label">${escapeHtml(b.label)}</div>`, page);
    out = replaceOnce(out, PLACEHOLDER_VALUE, `<div class="${b.valueClass}">${escapeHtml(b.value)}</div>`, page);

    out = replaceOnce(out, PLACEHOLDER_SOURCE, b.source
        ? `<span class="info-value" id="source"><a href="${escapeHtml(b.source.url)}" target="_blank" rel="noopener">${escapeHtml(b.source.name)}</a></span>`
        : `<span class="info-value" id="source">Unavailable</span>`, page);

    out = replaceOnce(out, PLACEHOLDER_CONFIDENCE, b.confidence
        ? `<span id="confidence" class="confidence confidence-${escapeHtml(b.confidence)}">${escapeHtml(b.confidence)}</span>`
        : `<span id="confidence" class="confidence confidence-none">none</span>`, page);

    // The "Last Updated" row is rewritten together with the rows that follow it, so precision and
    // state sit beside it. app.js only ever rewrites #last-updated, leaving the new rows intact.
    const rows: string[] = [
        `        <div class="info-row">
          <span class="info-label">Last Verified</span>
          <span class="info-value" id="last-updated">${escapeHtml(b.lastVerified ?? "Never")}</span>
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
          <span class="info-value">${escapeHtml(b.state)}</span>
        </div>`);
    out = replaceOnce(out, PLACEHOLDER_UPDATED_ROW, rows.join("\n"), page);

    out = replaceOnce(out, PLACEHOLDER_NOTES, b.notes
        ? `<div id="notes" class="notes">${escapeHtml(b.notes)}</div>`
        : PLACEHOLDER_NOTES, page);

    return out;
}

/** `data-game` / `data-type` on the page's hidden container say which tracker it shows. */
export function trackerOf(html: string): { game: string; type: string } | undefined {
    const match = /id="countdown-container"\s+data-game="([^"]+)"\s+data-type="([^"]+)"/.exec(html);
    return match ? { game: match[1], type: match[2] } : undefined;
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
    rendered: Array<{ page: string; game: string; type: string; status: string; value: string }>;
    /** Pages with no data file: rendered as unavailable rather than left showing a placeholder. */
    missingData: string[];
    /** Pages with no tracker container (home, about, privacy). */
    skipped: number;
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
export function renderSite(distDir: string): RenderSummary {
    const summary: RenderSummary = { rendered: [], missingData: [], skipped: 0 };
    const dataDir = path.join(distDir, "data");

    for (const file of htmlFilesIn(distDir)) {
        const html = fs.readFileSync(file, "utf8");
        const tracker = trackerOf(html);
        if (!tracker) {
            summary.skipped++;
            continue;
        }
        const page = path.relative(distDir, file).replace(/\\/g, "/");
        const data = readData(dataDir, tracker.game, tracker.type);
        if (!data) summary.missingData.push(page);

        const rendered = renderTrackerHtml(html, data, page);
        fs.writeFileSync(file, rendered, "utf8");
        const blocks = blocksFor(data);
        summary.rendered.push({ page, game: tracker.game, type: tracker.type, status: data?.status ?? "no-data", value: blocks.value });
    }
    return summary;
}

if (require.main === module) {
    const dist = path.join(process.cwd(), "dist");
    if (!fs.existsSync(dist)) {
        console.error("❌ No dist/ to render. Run export:site first.");
        process.exit(1);
    }
    const summary = renderSite(dist);
    for (const r of summary.rendered) console.log(`  ✓ ${r.page} — ${r.status}: ${r.value}`);
    for (const p of summary.missingData) console.warn(`  ⚠ ${p}: no data file; published as unavailable`);
    console.log(`✅ Rendered ${summary.rendered.length} tracker page(s); ${summary.skipped} page(s) have no tracker.`);
}
