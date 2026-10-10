/**
 * `/resets/` — every tracker's answer in one table, built from data the build already has.
 *
 * The site answers twelve questions on twelve pages, and until now the only place that showed all of
 * them at once was the homepage, where each is a card you scroll past. A reader who wants to compare —
 * what resets next, what time that is where they live, how often each one comes round — had nowhere to
 * look. This is that page.
 *
 * It is also where a tracker lives when its own page is not worth reading. Three are withheld from the
 * index (see `EDITORIAL_NOINDEX`), and their data is still real: Roblox's status is still verified,
 * Red Dead's last Newswire post still happened. Here they are rows like any other, carrying the same
 * verified value, simply without a link to a page we are not recommending. The reader loses nothing;
 * the index does not gain a thin page.
 *
 * Costs nothing to run. It reads `dist/data/*.json` — the files the trackers already publish — and the
 * knowledge store the build already checked out. No fetch, no model, no new source, no endpoint. The
 * visitor's own time zone is applied in their browser from the UTC value already in the HTML, so the
 * table is complete and correct with JavaScript switched off.
 */
import { findByAttribute, spliceElement } from "./html-elements";
import { REGION_ATTRIBUTE } from "./render-slots";
import { CardValue, cardValue } from "./render-home";
import { GameKnowledge, KnowledgeEvent, loadKnowledge, publishedEvents } from "./render-data-blocks";
import { TrackerData, escapeHtml, formatDate, formatDateTime, isFutureFacing } from "./render-pages";
import { isListed } from "./indexing";
import { trackerPages } from "./site-map";
import { gamePages } from "./update-game-pages";

const DAY_MS = 86_400_000;

/** How far ahead "soon" reaches. A week is the window the weekly resets actually live in. */
export const SOON_DAYS = 7;

export interface ResetRow {
    game: string;
    type: string;
    /** "GTA Online". */
    title: string;
    /** "Weekly reset". */
    tracks: string;
    /** The page, where that page is worth linking to. Absent for a tracker withheld from the index. */
    href?: string;
    /** How often this comes round, where the data supports saying. */
    cadence?: string;
    /** The published instant, ISO 8601, for the browser to convert. Absent when there is no value. */
    atIso?: string;
    /** The published value as the page states it: a date, a date and time, or a sentence. */
    when: string;
    /** Whether `when` is an instant the reader's own clock can be given for. */
    exact: boolean;
    /** LIVE / STALE / NO DATE / UNAVAILABLE, as the homepage badges it. */
    badge: string;
    badgeClass: string;
    /** This is ahead of now and within the week. */
    soon: boolean;
    /** Ordering key: the event instant, or undefined where there is none. */
    at?: number;
    /** Future-facing trackers come first; the data decides, as it does on the homepage. */
    upcoming: boolean;
}

/**
 * How often a tracker comes round, in words, or undefined where saying would be a guess.
 *
 * Two honest sources and no third. A recurring topic states its rule — Rockstar publishes GTA's, and
 * the adapter computes from it — and that rule is quotable as it stands. Everything else can only be
 * observed: if a game's published history is evenly spaced, the spacing is a fact about the history and
 * is worth reporting as "about every N", hedged because it describes what has happened rather than a
 * promise. Where the gaps are uneven — Valve ships Counter-Strike updates when they are ready — there
 * is no cadence to report, and the column stays empty rather than inventing a rhythm.
 */
export function cadenceOf(knowledge: GameKnowledge | undefined, topic: string, rule?: string): string | undefined {
    if (rule) return rule;
    const events = publishedEvents(knowledge?.events, topic)
        .map((event: KnowledgeEvent) => (event.at ? Date.parse(event.at) : NaN))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    // Four events is three gaps: enough for "evenly spaced" to mean something rather than describing a
    // single interval twice. Fewer, and there is nothing to be consistent about.
    if (events.length < 4) return undefined;
    const gaps = events.slice(1).map((at, index) => at - events[index]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 0) return undefined;
    // Most gaps close to the median, rather than all of them.
    //
    // This is a test of whether a rhythm is there to report, not a bar a game has to clear to deserve
    // something. League of Legends is the case that sets it: twenty-three gaps, twenty-one of them
    // thirteen to fifteen days, and two of twenty-one where a split break falls. Demanding that every
    // gap agree would throw away a two-week cycle that genuinely exists, because Riot takes Christmas
    // off. Allowing a quarter of them to disagree keeps that and still rejects Counter-Strike, where
    // Valve ships twice in a day and then not for a month and there is no rhythm to find.
    const close = gaps.filter(gap => Math.abs(gap - median) <= median * 0.25).length;
    if (close / gaps.length <= 0.75) return undefined;
    const days = Math.round(median / DAY_MS);
    if (days < 1) return undefined;
    if (days === 1) return "About daily";
    if (days === 7) return "About weekly";
    if (days % 7 === 0) return `About every ${days / 7} weeks`;
    return `About every ${days} days`;
}

/** The stated rule for a tracker whose cadence the publisher defines rather than the history showing. */
const STATED_CADENCE: Record<string, string> = {
    // Rockstar's schedule, which is what the GTA adapter computes from rather than reads off a page.
    "gta/weekly-reset": "Every Thursday, 10:00 UTC"
};

export interface ResetsInput {
    /** Reads a tracker's published file, exactly as the tracker pages and the homepage read it. */
    read: (game: string, type: string) => TrackerData | undefined;
    /** Reads a game's knowledge, for the cadence its history implies. */
    knowledge: (game: string) => GameKnowledge | undefined;
    now: Date;
}

/**
 * Every tracker as a row, in the order the page shows them.
 *
 * The same order the homepage uses, and for the same reason: what is coming up, soonest first, is what
 * a countdown site is for. Then what changed most recently, newest first. Then whatever has no answer.
 */
export function resetRows(input: ResetsInput): ResetRow[] {
    const rows: ResetRow[] = [];
    for (const entry of trackerPages()) {
        const { game, type } = entry.tracker!;
        const page = gamePages.find(candidate => candidate.game === game && candidate.type === type);
        if (!page) continue;
        const data = input.read(game, type);
        const value: CardValue = cardValue(data, input.now);
        const exact = data?.precision === "exact" && !value.unanswered && value.at !== undefined;
        const atIso = value.dataset.nextUtc || undefined;
        const ahead = value.at !== undefined && value.at > input.now.getTime();
        rows.push({
            game,
            type,
            title: page.title,
            tracks: page.typeTitle,
            href: isListed(entry.page) ? `/${game}/${type}/` : undefined,
            cadence: cadenceOf(input.knowledge(game), type, STATED_CADENCE[`${game}/${type}`]),
            atIso: value.unanswered ? undefined : atIso,
            when: value.value,
            exact,
            badge: value.badgeText,
            badgeClass: value.badgeClass,
            soon: ahead && value.at! - input.now.getTime() <= SOON_DAYS * DAY_MS,
            at: value.at,
            upcoming: value.group === "upcoming"
        });
    }

    return rows.sort((a, b) => {
        const rank = (row: ResetRow) => (row.at === undefined ? 2 : row.upcoming ? 0 : 1);
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
        if (a.at === undefined || b.at === undefined) return a.title.localeCompare(b.title);
        // Upcoming: soonest first. Recent: newest first. Both read as "nearest to now".
        return rank(a) === 0 ? a.at - b.at : b.at - a.at;
    });
}

/**
 * One row of the table.
 *
 * The UTC value is a `<time>` carrying the machine instant, so the browser can add the reader's own
 * clock beside it without the page having to be re-rendered or re-fetched. Where there is no instant —
 * a date announced without a time, or no answer at all — there is nothing to convert and the cell says
 * so rather than inventing a midnight.
 */
function rowHtml(row: ResetRow, indent: string): string {
    const pad = (depth: number) => indent + "  ".repeat(depth);
    const name = row.href
        ? `<a href="${row.href}">${escapeHtml(row.title)}</a>`
        : escapeHtml(row.title);
    const when = row.atIso
        ? `<time datetime="${escapeHtml(row.atIso)}">${escapeHtml(row.when)}</time>`
        : escapeHtml(row.when);
    // Only an exact instant gets something to convert: a day-precision date is the same day everywhere
    // it matters, and converting it would invent a time the publisher never gave.
    //
    // Both forms are served with the em dash already in them. The cell a browser will fill is not
    // served empty, because a reader without JavaScript would then meet a blank column and wonder what
    // was meant to be there. It says "nothing here" until something replaces it.
    const local = row.exact
        ? `<span class="reset-local is-none" data-utc="${escapeHtml(row.atIso!)}">—</span>`
        : `<span class="reset-local is-none">—</span>`;
    return [
        `${indent}<tr${row.soon ? ` class="is-soon"` : ""}>`,
        `${pad(1)}<th scope="row">${name}</th>`,
        `${pad(1)}<td>${escapeHtml(row.tracks)}</td>`,
        `${pad(1)}<td>${row.cadence ? escapeHtml(row.cadence) : `<span class="is-none">—</span>`}</td>`,
        `${pad(1)}<td>${when}${row.soon ? ` <span class="reset-soon">within ${SOON_DAYS} days</span>` : ""}</td>`,
        `${pad(1)}<td>${local}</td>`,
        `${pad(1)}<td><span class="${row.badgeClass}">${escapeHtml(row.badge)}</span></td>`,
        `${indent}</tr>`
    ].join("\n");
}

/** The table body, as HTML. Exported so a test can read it without a page around it. */
export function resetsTableHtml(rows: ResetRow[], indent = "          "): string {
    return rows.map(row => rowHtml(row, indent)).join("\n");
}

/**
 * Writes the rows into the page's table.
 *
 * The region is the `<tbody>`, declared by the page rather than matched by whatever markup is in it, so
 * the table can be restyled or re-ordered without touching this. A page that does not declare it, or
 * declares it twice, throws: publishing the hub with an empty table would be the same failure as
 * publishing a tracker page that still says "--:--:--".
 */
export function renderResetsHtml(html: string, rows: ResetRow[], page = "resets/index.html"): string {
    const regions = findByAttribute(html, REGION_ATTRIBUTE, "resets");
    if (regions.length !== 1) {
        throw new Error(`${page}: expected exactly one "resets" region, found ${regions.length}`);
    }
    if (rows.length === 0) throw new Error(`${page}: no trackers to list`);
    const region = regions[0];
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    const indent = " ".repeat(10);
    const body = resetsTableHtml(rows, indent).split("\n").join(eol);
    return spliceElement(html, region, `${region.openTag}${eol}${body}${eol}${" ".repeat(10)}</tbody>`);
}
