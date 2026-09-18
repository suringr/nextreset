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
import { validateGameKnowledge } from "./v2/validate";

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
    /** Where this row sits relative to now. Only a timeline sets it. */
    state?: RowState;
}

/**
 * Where a row sits relative to now.
 *
 * Only a timeline needs this: a list of past updates is all one thing, but a schedule a reader is
 * trying to place themselves in has to say which entry is the one they are waiting for.
 */
export type RowState = "past" | "next" | "scheduled";

export interface Block {
    title: string;
    rows: BlockRow[];
    /** One sentence explaining what the reader is looking at, where that is not obvious. */
    note?: string;
    /**
     * How the block should be read.
     *
     * A `list` is a set of rows that happen to be ordered. A `timeline` is a sequence a reader places
     * themselves in — which is why it runs oldest to newest, marks the current entry, and keeps past
     * and future in one column instead of two separate sections.
     */
    shape?: "list" | "timeline";
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
    try {
        // Exactly the validation the pipeline applies before it will store or serve a file. If the
        // store would refuse to load this, a page must not publish blocks from it either: otherwise
        // corrupt knowledge could render "verified" rows beside an unavailable headline.
        const validated = validateGameKnowledge(parsed, `knowledge/games/${game}.json`);
        if (validated.game !== game) return undefined;
        return {
            game: validated.game,
            events: validated.events as unknown as KnowledgeEvent[],
            claims: validated.claims as unknown as KnowledgeClaim[],
            documents: validated.documents as unknown as KnowledgeDocument[]
        };
    } catch {
        return undefined;
    }
}

function endOf(event: KnowledgeEvent): number | undefined {
    if (!event.at) return undefined;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) return undefined;
    // A date-only event owns its whole day, exactly as the pipeline treats it.
    return at + (event.precision === "exact" ? 0 : DAY_MS);
}

/** The events of a topic this site is allowed to show: held events are ours to know, not to publish. */
export function publishedEvents(events: KnowledgeEvent[] | undefined, topic: string): KnowledgeEvent[] {
    return (events ?? []).filter(e => e.topic === topic && e.publishState !== "held" && typeof e.at === "string");
}

const published = publishedEvents;

/**
 * Whether a claim still describes what the event says today.
 *
 * A date that is corrected and later reverted keeps all three claims, and the intervening correction
 * is the newest of them — but it states a value the event no longer holds. Pairing the restored date
 * with that quote would show a reader two different dates as one fact.
 */
function statesCurrentValue(claim: KnowledgeClaim, event: KnowledgeEvent): boolean {
    if (claim.field !== "at" || claim.value === undefined || event.at === undefined) return true;
    if (claim.value === event.at) return true;
    const claimed = Date.parse(claim.value);
    const current = Date.parse(event.at);
    return Number.isFinite(claimed) && Number.isFinite(current) && claimed === current;
}

/** The claim that carries this event's link and (where readable) its quote. */
function evidenceFor(event: KnowledgeEvent, knowledge: GameKnowledge): { href?: string; quote?: string } {
    const claims = (knowledge.claims ?? [])
        .filter(c => c.eventKey === event.key && statesCurrentValue(c, event))
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
    // The adapter appends "dates vary" when the shared server time lands on different UTC dates per
    // region. The label carries each region's clock time but not its date, and deriving one would mean
    // assuming fixed offsets across daylight saving. Showing a time a reader would pair with the
    // headline's date — and be a day out — is worse than showing nothing, so the block is dropped.
    // Publishing the three instants as fields in the adapter would let this render properly.
    if (/dates vary/i.test(inside[1])) return [];
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
    /**
     * Whether the page is actually publishing a value. When it is not — the headline reads "no official
     * date announced" or "data unavailable" — forward-looking blocks are suppressed, because listing
     * upcoming dates underneath a headline that says none is known contradicts the page.
     * History is still shown: what already happened is unaffected by today's failed check.
     */
    headlineAnswered?: boolean;
}

/**
 * How far either side of the current entry a timeline reaches.
 *
 * Deliberately the caps the two lists it replaces already used, so the timeline shows exactly what
 * "Previously" and "Also scheduled" showed between them and no verified row is lost by changing shape.
 * A first attempt used a short window for phone readability and quietly dropped eight of League of
 * Legends' twelve published patches — eight rows of dated, linked, quoted evidence — from a site that
 * was rejected for thin content. One sequence of the same rows is the change; fewer rows is not.
 */
const TIMELINE_BEHIND = MAX_HISTORY_ROWS;
const TIMELINE_AHEAD = MAX_UPCOMING_ROWS;

/**
 * A published schedule as one sequence, for a topic whose events are versions of the same thing.
 *
 * League of Legends publishes its whole year: twelve patches behind the current one and six ahead. As
 * two separate sections — "Previously" newest-first and "Also scheduled" soonest-first — a reader
 * cannot see where the patch they are waiting for sits, and the two lists run in opposite directions.
 * As one column, oldest to newest, with the current entry marked, the question answers itself.
 *
 * This is only right where the events really are a sequence. An update history (Counter-Strike's
 * nineteen updates, all in the past, none scheduled) is a list, and rendering it as a timeline would
 * imply a cadence Valve does not publish.
 */
export function timelineFor(knowledge: GameKnowledge, topic: string, options: BlockOptions): Block | undefined {
    const events = published(knowledge.events, topic);
    if (events.length === 0) return undefined;
    const nowMs = options.now.getTime();

    // Two things have to be true, and the second is the one that matters.
    //
    // The events must be versions of one thing — an update feed, a status observation and a recurring
    // rule are not sequences however many rows they have.
    if (!events.some(event => event.kind === "version")) return undefined;

    // And the store must hold entries on both sides of now, because a timeline is something a reader
    // places themselves in. This is what separates League of Legends, which publishes its whole year,
    // from PUBG, VALORANT, EA SPORTS FC and Minecraft — all of them "version" events too, and all of
    // them feeds of releases that have already happened. Drawing those on a rail with past markers
    // would imply a cadence the publisher does not announce. They stay a list, which is what they are.
    //
    // "Ahead" means a *scheduled* event ahead — one the publisher announced. An update feed's observed
    // release can carry a timestamp slightly after now (source clock skew, or a change that landed while
    // the request was in flight; selectCurrentEvent allows for exactly that), and a timestamp alone would
    // turn that feed into a timeline and present a release that already happened as "Next".
    const behindNow = events.some(event => (endOf(event) ?? 0) <= nowMs);
    const aheadNow = events.some(event => event.status === "scheduled" && (endOf(event) ?? 0) > nowMs);
    if (!behindNow || !aheadNow) return undefined;

    const ordered = [...events].sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    const answered = options.headlineAnswered !== false;

    // The entry the page's headline is about, so the timeline marks the same one the reader just read.
    const currentIndex = options.currentKey
        ? ordered.findIndex(event => event.key === options.currentKey)
        : ordered.findIndex(event => (endOf(event) ?? 0) > nowMs);

    const pivot = currentIndex >= 0 ? currentIndex : ordered.length;
    const behind = ordered.slice(Math.max(0, pivot - TIMELINE_BEHIND), pivot);
    // A page that cannot answer its question does not list what comes after the answer it does not have.
    const ahead = answered && currentIndex >= 0 ? ordered.slice(pivot, pivot + TIMELINE_AHEAD + 1) : [];


    const rows: BlockRow[] = [...behind, ...ahead].map(event => {
        const past = (endOf(event) ?? 0) <= nowMs;
        // A past row says "Past", never "Released". A timeline is a schedule, and a schedule shows that a
        // date was announced, not that the patch shipped on it: a patch can slip, be cancelled, or go
        // unobserved. No status in the store is evidence of a release either — discovery marks every
        // version whose date has gone by "observed" on the clock alone, and a date that passes on its own
        // becomes "ended". So the row claims exactly what the schedule supports, as the block's note does.
        const state: RowState = event.key === options.currentKey && !past ? "next" : past ? "past" : "scheduled";
        return { label: event.label, when: options.format(event.at!, event.precision), state, ...evidenceFor(event, knowledge) };
    });
    // The same bar every other block clears: fewer rows than this and it is a heading with a couple of
    // lines under it, which is not worth a section. One rule, not two.
    if (rows.length < MIN_HISTORY_ROWS) return undefined;

    return {
        title: "Patch timeline",
        note: "Every date here was read from the official schedule. Dates after the next one can still change.",
        shape: "timeline",
        rows
    };
}

/** Every block this game's data supports, in the order they should appear. Empty when it supports none. */
export function blocksFor(knowledge: GameKnowledge | undefined, topic: string, options: BlockOptions): Block[] {
    if (!knowledge) return [];
    const events = published(knowledge.events, topic);
    if (events.length === 0) return [];

    const blocks: Block[] = [];
    const nowMs = options.now.getTime();
    const byAt = (a: KnowledgeEvent, b: KnowledgeEvent) => Date.parse(a.at!) - Date.parse(b.at!);

    const answered = options.headlineAnswered !== false;

    // A published sequence replaces the two lists it would otherwise be split across: where a timeline
    // is the right shape, "Also scheduled" and "Previously" are the same rows read twice, in opposite
    // directions, on either side of a gap the reader has to hold in their head.
    const timeline = timelineFor(knowledge, topic, options);
    if (timeline) {
        blocks.push(timeline);
        return blocks;
    }

    // 1. Everything still ahead that the source has already published, minus the headline value.
    const upcoming = !answered ? [] : events
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
    const regional = current && answered ? regionalTimes(current.label) : [];
    if (regional.length > 0) {
        blocks.push({
            title: "When it ends in each region",
            note: "Each region's servers reach that local time at a different moment, so the same deadline is three different instants.",
            rows: regional
        });
    }

    // 4. A recurring rule can be projected forward, and is labelled as computed rather than verified.
    if (answered && current?.kind === "recurring" && current.at) {
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

/** What a timeline row says about where it sits. The word carries it, not the colour. */
const STATE_WORDS: Record<RowState, string> = {
    past: "Past",
    next: "Next",
    scheduled: "Scheduled"
};

/** A row's label, linked to the official post it was verified from where there is one. */
function rowLabel(row: BlockRow): string {
    return row.href
        ? `<a href="${escapeHtml(row.href)}" target="_blank" rel="noopener">${escapeHtml(row.label)}</a>`
        : escapeHtml(row.label);
}

/** The blocks as HTML for the page's data slot. Returns "" when there is nothing to show. */
export function renderBlocks(blocks: Block[]): string {
    if (blocks.length === 0) return "";
    const parts: string[] = [];
    for (const block of blocks) {
        const rows = block.shape === "timeline"
            ? block.rows.map(row => {
                const state = row.state ?? "scheduled";
                const quote = row.quote ? `<div class="data-quote">${escapeHtml(row.quote)}</div>` : "";
                // The state is a word as well as a class: a reader who cannot separate the colours still
                // reads which entry is next.
                return `          <li class="event is-${state}"><span class="event-label">${rowLabel(row)}</span><span class="event-when">${escapeHtml(row.when)}</span><span class="event-state">${STATE_WORDS[state]}</span>${quote}</li>`;
            }).join("\n")
            : block.rows.map(row => {
                const quote = row.quote ? `<div class="data-quote">${escapeHtml(row.quote)}</div>` : "";
                return `          <li class="data-row"><span class="data-label">${rowLabel(row)}</span><span class="data-when">${escapeHtml(row.when)}</span>${quote}</li>`;
            }).join("\n");
        const listClass = block.shape === "timeline" ? "timeline" : "data-list";
        parts.push(`      <div class="content-section">
        <h2>${escapeHtml(block.title)}</h2>
${block.note ? `        <p class="data-note">${escapeHtml(block.note)}</p>\n` : ""}        <ul class="${listClass}">
${rows}
        </ul>
      </div>`);
    }
    return parts.join("\n");
}
