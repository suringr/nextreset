/**
 * The blocks of verified data a tracker page can honestly show, derived from the knowledge store.
 *
 * Milestone 1 published one value per page. The store holds far more: League of Legends' remaining
 * patch schedule, Counter-Strike's update history with a link per post, Genshin's three regional end
 * times. None of it reached a page. This module turns what a game actually has into blocks, and
 * returns nothing where the data does not support a block — an empty section is worse than no section.
 *
 * It reads `knowledge/games/<game>.json`, which CI checks out before the build. That directory is
 * absent on a plain clone, so every entry point degrades to "no blocks" rather than failing.
 *
 * Nothing here fetches, and nothing here calls a model.
 */
import * as fs from "fs";
import * as path from "path";

export interface KnowledgeEvent {
    key: string;
    game?: string;
    topic: string;
    kind?: string;
    label: string;
    status: string;
    at?: string;
    precision?: string;
    timezone?: string;
    firstSeen?: string;
    lastVerified?: string;
    publishState?: string;
}

export interface KnowledgeClaim {
    id?: string;
    documentId?: string;
    eventKey: string;
    field: string;
    value?: string;
    /** "ai" means it was read from prose; "deterministic" means the quote is machine text. */
    method?: string;
    quote?: string;
    linkUrl?: string;
    extractedAt?: string;
}

export interface KnowledgeDocument {
    id: string;
    url: string;
    title?: string;
}

export interface GameKnowledge {
    game?: string;
    events?: KnowledgeEvent[];
    claims?: KnowledgeClaim[];
    documents?: KnowledgeDocument[];
}

export interface BlockRow {
    /** What it was: "26.19", "Counter-Strike 2 Update". */
    label: string;
    /** When, already formatted for reading. */
    when: string;
    /** The official post or article this row was verified from, when there is one. */
    href?: string;
    /** A verbatim quote, only where the stored quote is prose a person can read. */
    quote?: string;
}

export interface Block {
    title: string;
    rows: BlockRow[];
    /** One sentence explaining what the reader is looking at, where that is not obvious. */
    note?: string;
}

const DAY_MS = 86_400_000;
/** Enough rows to be a reference rather than a teaser; fewer than this and the block is not worth a heading. */
export const MIN_HISTORY_ROWS = 3;
export const MAX_HISTORY_ROWS = 12;
const MAX_UPCOMING_ROWS = 12;
/** How many occurrences of a recurring rule to project. */
const COMPUTED_OCCURRENCES = 4;

/**
 * Reads a game's knowledge, or undefined when the store is absent (a plain clone, or a local run).
 *
 * The file is input, not a contract: valid JSON can still be the wrong shape, and the pipeline's own
 * loader treats that as unavailable rather than trusting it. Each collection is therefore accepted
 * only if it is actually an array, so a corrupt file costs a page its blocks instead of the build.
 */
export function loadKnowledge(root: string, game: string): GameKnowledge | undefined {
    const file = path.join(root, "knowledge", "games", `${game}.json`);
    if (!fs.existsSync(file)) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const arrayOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    return {
        game: typeof record.game === "string" ? record.game : undefined,
        events: arrayOf<KnowledgeEvent>(record.events).filter(e => e && typeof e === "object"),
        claims: arrayOf<KnowledgeClaim>(record.claims).filter(c => c && typeof c === "object"),
        documents: arrayOf<KnowledgeDocument>(record.documents).filter(d => d && typeof d === "object")
    };
}

function endOf(event: KnowledgeEvent): number | undefined {
    if (!event.at) return undefined;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) return undefined;
    // A date-only event owns its whole day, exactly as the pipeline treats it.
    return at + (event.precision === "exact" ? 0 : DAY_MS);
}

function published(events: KnowledgeEvent[] | undefined, topic: string): KnowledgeEvent[] {
    return (events ?? []).filter(e => e.topic === topic && e.publishState !== "held" && typeof e.at === "string");
}

/** The claim that carries this event's link and (where readable) its quote. */
function evidenceFor(event: KnowledgeEvent, knowledge: GameKnowledge): { href?: string; quote?: string } {
    const claims = (knowledge.claims ?? [])
        .filter(c => c.eventKey === event.key)
        // A corrected date appends a new claim and keeps the old one. The newest claim describes what
        // the event says now, so its link and quote are the ones that belong beside it (views.ts does
        // the same when choosing an attribution link).
        .sort((a, b) => (b.extractedAt ?? "").localeCompare(a.extractedAt ?? ""));
    for (const claim of claims) {
        const document = claim.documentId ? (knowledge.documents ?? []).find(d => d.id === claim.documentId) : undefined;
        const href = claim.linkUrl ?? document?.url;
        // Only a quote extracted from prose is readable. A deterministic quote is raw API JSON or HTML,
        // which is evidence for us and noise for a reader.
        const quote = claim.method === "ai" && claim.quote ? claim.quote : undefined;
        if (href || quote) return { href, quote };
    }
    return {};
}

/**
 * Genshin's event label states the same wall clock for three server regions, each a different real
 * instant: "… ends 2026-09-22 14:59 server time (Asia 06:59 UTC, Europe 13:59 UTC, America 19:59 UTC)".
 *
 * The three instants exist only inside that string, so they are read back with a strict pattern that
 * must find all three known regions. Anything else returns nothing rather than guessing: a mis-read
 * region would tell a player the wrong deadline.
 */
export function regionalTimes(label: string): BlockRow[] {
    const inside = /\(([^)]*)\)/.exec(label);
    if (!inside) return [];
    const wanted = ["Asia", "Europe", "America"];
    const rows: BlockRow[] = [];
    for (const region of wanted) {
        const match = new RegExp(`\\b${region}\\s+(\\d{2}:\\d{2})\\s*UTC`).exec(inside[1]);
        if (!match) return [];
        rows.push({ label: region, when: `${match[1]} UTC` });
    }
    return rows.length === wanted.length ? rows : [];
}

/** Later occurrences of a recurring rule, projected from the one the source verified. */
export function computedOccurrences(from: string, everyDays: number, count: number, format: (iso: string) => string): BlockRow[] {
    const start = Date.parse(from);
    if (!Number.isFinite(start)) return [];
    const rows: BlockRow[] = [];
    for (let i = 1; i <= count; i++) {
        const at = new Date(start + i * everyDays * DAY_MS).toISOString();
        rows.push({ label: "Reset", when: format(at) });
    }
    return rows;
}

export interface BlockOptions {
    /** Formats an instant the way the rest of the page does (date, or date and time when exact). */
    format: (iso: string, precision?: string) => string;
    now: Date;
    /** The event currently shown as the page's headline value, so blocks do not repeat it. */
    currentKey?: string;
}

/** Every block this game's data supports, in the order they should appear. Empty when it supports none. */
export function blocksFor(knowledge: GameKnowledge | undefined, topic: string, options: BlockOptions): Block[] {
    if (!knowledge) return [];
    const events = published(knowledge.events, topic);
    if (events.length === 0) return [];

    const blocks: Block[] = [];
    const nowMs = options.now.getTime();
    const byAt = (a: KnowledgeEvent, b: KnowledgeEvent) => Date.parse(a.at!) - Date.parse(b.at!);

    // 1. Everything still ahead that the source has already published, minus the headline value.
    const upcoming = events
        .filter(e => e.status === "scheduled" && (endOf(e) ?? 0) > nowMs && e.key !== options.currentKey)
        .sort(byAt)
        .slice(0, MAX_UPCOMING_ROWS);
    if (upcoming.length > 0) {
        blocks.push({
            title: "Also scheduled",
            note: "Dates the publisher has already announced, verified from the official source.",
            rows: upcoming.map(e => ({ label: e.label, when: options.format(e.at!, e.precision), ...evidenceFor(e, knowledge) }))
        });
    }

    // 2. What has already happened, newest first — but only where the publisher actually evidenced it.
    //    A rule-based topic (GTA's weekly reset) generates its past occurrences locally, with no claim
    //    and no document. Listing those under "verified against the publisher's archive" would claim a
    //    provenance they do not have, so they are left out; the rule is projected forward instead.
    const evidenced = (event: KnowledgeEvent) => {
        const evidence = evidenceFor(event, knowledge);
        return evidence.href !== undefined || evidence.quote !== undefined;
    };
    const past = events
        .filter(e => (endOf(e) ?? 0) <= nowMs && e.key !== options.currentKey && evidenced(e))
        .sort(byAt)
        .reverse()
        .slice(0, MAX_HISTORY_ROWS);
    if (past.length >= MIN_HISTORY_ROWS) {
        blocks.push({
            title: "Previously",
            // Deliberately not "verified against the archive": for a schedule-based topic the evidence
            // shows the publisher announced that date, not that the release happened on it. What is
            // true for every row is that the date came from the official source at the time.
            note: "Each of these dates came from the official source at the time.",
            rows: past.map(e => ({ label: e.label, when: options.format(e.at!, e.precision), ...evidenceFor(e, knowledge) }))
        });
    }

    // 3. One wall clock, three regions, three real instants.
    const current = events.find(e => e.key === options.currentKey) ?? events[events.length - 1];
    const regional = current ? regionalTimes(current.label) : [];
    if (regional.length > 0) {
        blocks.push({
            title: "When it ends in each region",
            note: "Each region's servers reach that local time at a different moment, so the same deadline is three different instants.",
            rows: regional
        });
    }

    // 4. A recurring rule can be projected forward, and is labelled as computed rather than verified.
    if (current?.kind === "recurring" && current.at) {
        const rows = computedOccurrences(current.at, 7, COMPUTED_OCCURRENCES, iso => options.format(iso, current.precision));
        if (rows.length > 0) {
            blocks.push({
                title: "Then",
                note: "Computed from the published weekly schedule, not read from a page.",
                rows
            });
        }
    }

    return blocks;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The blocks as HTML for the page's data slot. Returns "" when there is nothing to show. */
export function renderBlocks(blocks: Block[]): string {
    if (blocks.length === 0) return "";
    const parts: string[] = [];
    for (const block of blocks) {
        const rows = block.rows.map(row => {
            const label = row.href
                ? `<a href="${escapeHtml(row.href)}" target="_blank" rel="noopener">${escapeHtml(row.label)}</a>`
                : escapeHtml(row.label);
            const quote = row.quote ? `<div class="data-quote">${escapeHtml(row.quote)}</div>` : "";
            return `          <li class="data-row"><span class="data-label">${label}</span><span class="data-when">${escapeHtml(row.when)}</span>${quote}</li>`;
        }).join("\n");
        parts.push(`      <div class="content-section">
        <h2>${escapeHtml(block.title)}</h2>
${block.note ? `        <p class="data-note">${escapeHtml(block.note)}</p>\n` : ""}        <ul class="data-list">
${rows}
        </ul>
      </div>`);
    }
    return parts.join("\n");
}
