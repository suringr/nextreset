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
import { GameKnowledge, KnowledgeEvent, isEvidenced, loadKnowledge, publishedEvents } from "./render-data-blocks";
import { TrackerData, escapeHtml, formatDate, formatDateTime } from "./render-pages";
import { isListed } from "./indexing";
import { trackerPages } from "./site-map";
import { gamePages } from "./update-game-pages";
import { RECENT_GAPS, cadenceFor, cadenceOf, recentCount, recordedReleases, subjectFor, utcDaysBetween } from "./release-rhythm";

// Defined with the rest of the release-history arithmetic, so a tracker page and this table read the
// same figure from the same code. Re-exported because this is where callers have always found them.
export { RECENT_GAPS, cadenceOf };

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
    /** How far the value is from today, in UTC days: "in 7 days", "today", "8 days ago". Absent with no value. */
    distance?: string;
    /** Releases this site recorded in the last RECENT_WINDOW_DAYS days, for a release feed; absent otherwise. */
    recorded?: string;
    /** Whether `when` is an instant the reader's own clock can be given for. */
    exact: boolean;
    /** CURRENT / STALE / NO DATE / UNAVAILABLE, as the homepage badges it. */
    badge: string;
    badgeClass: string;
    /** This is ahead of now and within the week. */
    soon: boolean;
    /** Ordering key: the event instant, or undefined where there is none. */
    at?: number;
    /** Future-facing trackers come first; the data decides, as it does on the homepage. */
    upcoming: boolean;
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
        // A tracker the manifest declares but the registry has no copy for cannot be given a row, and
        // skipping it would publish a table that silently omits a game while still passing the "not
        // empty" check. The publish job does not run the tests, so this is the only thing standing
        // between registry drift and a hub that quietly loses a tracker.
        const page = gamePages.find(candidate => candidate.game === game && candidate.type === type);
        if (!page) {
            throw new Error(`${game}/${type}: declared as a tracker page but absent from the tracker registry, so /resets/ cannot describe it`);
        }
        const data = input.read(game, type);
        const value: CardValue = cardValue(data, input.now);
        const exact = data?.precision === "exact" && !value.unanswered && value.at !== undefined;
        const atIso = value.dataset.nextUtc || undefined;
        const ahead = value.at !== undefined && value.at > input.now.getTime();
        // The homepage says "Updating..." for an exact instant that has just passed, because it is a
        // live countdown with nothing to count to until the next refresh. A table of facts is not that
        // page: it still knows the instant, and printing a placeholder in the UTC column while the
        // column beside it showed that same instant converted would be the table contradicting itself.
        // So the published value is always formatted here, and only the states that genuinely have no
        // value — unavailable, or a question with no answer — keep their sentence.
        const when = value.at !== undefined
            ? (exact ? formatDateTime(atIso!) : formatDate(atIso!))
            : value.value;
        // Counted in UTC calendar days, like every other day count on the site, so a clock change
        // cannot move it. A day-precision value is a day, and a day has no hours to be "in 0.6 days".
        const raw = value.at !== undefined && !value.unanswered ? utcDaysBetween(input.now.getTime(), value.at) : undefined;
        // An observation is never ahead, whatever its timestamp says. The pipeline keeps a just-published
        // update whose time is a little past the clock (source skew, or a change mid-request); across UTC
        // midnight that would read "in 1 day" for an update that has already shipped (Codex, #79).
        // Within the same one-day allowance recordedReleases uses; an observation further ahead is bad
        // data, not skew, and gets no distance at all rather than a "Today" beside a future date (Codex, #79).
        const skewedAt = raw !== undefined && value.group !== "upcoming" && value.at! > input.now.getTime();
        const offset = !skewedAt ? raw : value.at! - input.now.getTime() <= DAY_MS ? 0 : undefined;
        const distance = offset === undefined ? undefined
            : offset === 0 ? "Today"
            : offset > 0 ? `in ${offset} ${offset === 1 ? "day" : "days"}`
            : `${-offset} ${offset === -1 ? "day" : "days"} ago`;
        // Only a release feed has releases to count; a schedule, a rule and a status do not. The count
        // is of what this site recorded from the official source, by the same rule the tracker pages
        // use, and it is labelled as such: zero recorded is not proof that nothing was released.
        const subject = subjectFor(type);
        const knowledge = input.knowledge(game);
        const releases = subject && knowledge ? recordedReleases(knowledge, type, input.now, event => isEvidenced(event, knowledge)) : undefined;
        const recorded = subject && releases && releases.instants.length > 0
            ? (() => { const n = recentCount(releases.instants, input.now); return `${n} ${n === 1 ? subject.singular : subject.plural}`; })()
            : undefined;
        rows.push({
            game,
            type,
            title: page.title,
            tracks: page.typeTitle,
            ...(distance ? { distance } : {}),
            ...(recorded ? { recorded } : {}),
            href: isListed(entry.page) ? `/${game}/${type}/` : undefined,
            cadence: cadenceFor(input.knowledge(game), type, input.now, STATED_CADENCE[`${game}/${type}`]),
            atIso: value.unanswered ? undefined : atIso,
            when,
            exact,
            badge: value.badgeText,
            badgeClass: value.badgeClass,
            // Only something that is actually ahead of the reader can be "within 7 days". A last-patch
            // row is a past observation, and the pipeline deliberately keeps one whose timestamp sits a
            // little ahead of the clock — source skew, or a change that landed mid-request (see
            // selectCurrentEvent). Without the group test, that skew would advertise a patch that has
            // already shipped as something still to come.
            soon: value.group === "upcoming" && ahead && value.at! - input.now.getTime() <= SOON_DAYS * DAY_MS,
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
        `${pad(1)}<td>${row.distance ? escapeHtml(row.distance) : `<span class="is-none">—</span>`}</td>`,
        `${pad(1)}<td>${row.recorded ? escapeHtml(row.recorded) : `<span class="is-none">—</span>`}</td>`,
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
