/**
 * Render the homepage's verified values at build time.
 *
 * The homepage shipped twelve cards that all said "Loading...". Everything a reader (or a crawler
 * without JavaScript) could see was the list of games — the dates, which are the entire point, existed
 * only after app.js fetched them. This step writes those values into the HTML, and while it is there it
 * puts the cards in an order the data decides: what is coming up, soonest first; what was updated most
 * recently; and, last, whatever no official source has answered yet.
 *
 * Like the tracker renderer it reads only dist/data/*.json, writes only into dist/, and calls nothing.
 * app.js still overwrites the same nodes on load, turning an exact instant into a live countdown.
 *
 * The authored page under public/ stays as it is: unordered cards that say "Loading...". If this step
 * were removed, the homepage would simply go back to what it was.
 */
import * as cheerio from "cheerio";
import { TrackerData, escapeHtml, formatDate, formatDateTime, hasNoVerifiedValue, isFutureFacing, isUnanswered, sourceName } from "./render-pages";
import { cardRegion, replaceSlot } from "./render-slots";

/** Which part of the page a card belongs in. The data decides; the page does not choose. */
export type CardGroup = "upcoming" | "recent" | "unknown";

export const GROUP_HEADINGS: Record<CardGroup, string> = {
    upcoming: "Next up",
    recent: "Recently updated",
    unknown: "Waiting on an official source"
};

/** The order the groups appear in. Upcoming first: it is what a countdown site is for. */
export const GROUP_ORDER: CardGroup[] = ["upcoming", "recent", "unknown"];

export interface CardValue {
    group: CardGroup;
    badgeText: string;
    badgeClass: string;
    /** The value as HTML text, already decided — a date, a time, or a sentence. */
    value: string;
    /** The value is a date or a sentence rather than a short countdown, so it is set smaller. */
    compact: boolean;
    state: string;
    /** When the source was last checked, absolute: a cached page must not claim "2 hours ago" forever. */
    checked?: string;
    /** Epoch ms of the event, for ordering within a group. */
    at?: number;
    unanswered: boolean;
    /**
     * What the card tells the browser about its value: the instant, its precision and its status.
     *
     * Empty for a value the pipeline has rejected. The 60-second updater works from these attributes,
     * so leaving a rejected instant here would let it count down to a date the page refuses to publish.
     */
    dataset: { nextUtc: string; precision: string; status: string };
}


/**
 * What one card should say, from that tracker's published file alone.
 *
 * The decisions here are the ones app.js makes on load (renderCard), so hydration changes the form of a
 * value — a date becomes a live countdown — and never its meaning.
 */
export function cardValue(data: TrackerData | undefined, now: Date): CardValue {
    const checked = data?.fetched_at_utc ? `Checked ${formatDateTime(data.fetched_at_utc)}` : undefined;
    const empty = { nextUtc: "", precision: "", status: "" };

    if (hasNoVerifiedValue(data)) {
        // Nothing published, or a value the pipeline no longer stands behind. Its instant is not carried
        // into the page at all: an hour later the updater would otherwise count down to it.
        return { group: "unknown", badgeText: "UNAVAILABLE", badgeClass: "badge badge-unavailable", value: "Data unavailable", compact: false, state: "unavailable", checked, unanswered: false, dataset: empty };
    }
    const value = data as TrackerData & { nextEventUtc: string };
    const dataset = { nextUtc: value.nextEventUtc, precision: value.precision ?? "", status: value.status ?? "" };

    if (isUnanswered(value, now)) {
        // The date it used to show has expired and nothing has replaced it. Never a countdown, never LIVE.
        return { group: "unknown", badgeText: "NO DATE", badgeClass: "badge badge-unavailable", value: "No official date announced", compact: true, state: "unavailable", checked, unanswered: true, dataset };
    }

    const at = Date.parse(value.nextEventUtc);
    const ahead = at > now.getTime();
    const stale = value.status === "stale";
    const badgeText = stale ? "STALE" : "LIVE";
    const badgeClass = stale ? "badge badge-stale" : "badge badge-live";
    const state = stale ? "stale" : "live";
    // A time is published only where the pipeline states the instant is exact; otherwise midnight UTC is
    // a storage artefact and the value is a date (the rule blocksFor applies on the tracker pages).
    const exact = value.precision === "exact";
    // A future-facing value still answers its question here — isUnanswered has already had its say — so
    // it belongs under "next up" whether its moment is ahead, happening, or awaiting the next refresh.
    const group: CardGroup = isFutureFacing(value.type) ? "upcoming" : "recent";

    // An exact instant that has just passed: the next one arrives with the next refresh, and app.js says
    // "Updating..." for that moment. A date-only value is not in that position — it was announced for a
    // day, not an instant, so it stays its own date until the day is over.
    if (!ahead && exact && isFutureFacing(value.type)) {
        return { group, badgeText, badgeClass, value: "Updating...", compact: false, state, checked, at, unanswered: false, dataset };
    }

    return {
        group,
        dataset,
        badgeText,
        badgeClass,
        value: exact ? formatDateTime(value.nextEventUtc) : formatDate(value.nextEventUtc),
        compact: true,
        state,
        checked,
        at,
        unanswered: false
    };
}

/** One card as it was authored: what stays the same whatever the data says. */
export interface AuthoredCard {
    href: string;
    id: string;
    game: string;
    type: string;
    title: string;
    topic: string;
    /** Every attribute the card was written with, so re-emitting it cannot quietly drop one. */
    attributes: Record<string, string>;
}

/** The attributes the build decides. Everything else on the card belongs to whoever authored it. */
const BUILD_ATTRIBUTES = new Set(["data-state", "data-next-utc", "data-precision", "data-status", "data-checked-utc", "data-unanswered"]);

/** Reads the fixed parts of an authored card. Anything missing is template drift, so it throws. */
export function readCard(cardHtml: string): AuthoredCard {
    const card = cheerio.load(cardHtml)("a.card");
    const attributes = (card.attr() ?? {}) as Record<string, string>;
    const href = card.attr("href");
    const id = card.attr("id");
    const game = card.attr("data-game");
    const type = card.attr("data-type");
    const title = card.find(".card-title").text().trim();
    const topic = card.find(".card-topic").text().trim();
    if (!href || !id || !game || !type || !title || !topic) {
        throw new Error(`home: a card is missing href/id/data-game/data-type/title/topic (${cardHtml.slice(0, 80)})`);
    }
    return { href, id, game, type, title, topic, attributes };
}

/**
 * Orders cards within the page.
 *
 * Upcoming runs soonest first, so the top of the page is the next thing to happen. Recently updated
 * runs newest first. Anything unanswered sorts by name, because there is no date to sort it by — and it
 * goes last, since a reader scanning the page should reach the facts before the gaps.
 */
export function orderCards<T extends { card: AuthoredCard; value: CardValue }>(cards: T[]): T[] {
    const rank = (group: CardGroup) => GROUP_ORDER.indexOf(group);
    return [...cards].sort((a, b) => {
        const byGroup = rank(a.value.group) - rank(b.value.group);
        if (byGroup !== 0) return byGroup;
        if (a.value.group === "unknown" || a.value.at === undefined || b.value.at === undefined) {
            return a.card.title.localeCompare(b.card.title);
        }
        const byDate = a.value.group === "upcoming" ? a.value.at - b.value.at : b.value.at - a.value.at;
        // Two events at the same instant would otherwise swap places between builds for no reason.
        return byDate !== 0 ? byDate : a.card.title.localeCompare(b.card.title);
    });
}

/**
 * One rendered card, inside the slot that also holds its track control.
 *
 * The whole card is a link, and the track control is a sibling of that link rather than a child of it.
 * The V4 prototype nested a `<button>` inside the `<a>`, which is invalid HTML and gives a phone an
 * ambiguous target: a tap near the star either follows the link or toggles tracking depending on how
 * the browser resolves it. Two controls, side by side, each with its own 44px target.
 *
 * The control ships `hidden`. It does nothing without JavaScript, and a dead control is worse than no
 * control; app.js reveals it once it can honour a press.
 */
export function renderCardHtml(card: AuthoredCard, value: CardValue, data: TrackerData | undefined, eol: string): string {
    // Whatever the card was written with is written back — a modifier class, an aria-label, anything a
    // later edit adds — and only the attributes the build owns are replaced.
    const authored = Object.entries(card.attributes)
        .filter(([name]) => !BUILD_ATTRIBUTES.has(name))
        .map(([name, content]) => `${name}="${escapeHtml(content)}"`)
        .join(" ");
    const lines = [
        `      <div class="card-slot" data-game="${escapeHtml(card.game)}">`,
        `        <a ${authored}`,
        `          data-state="${escapeHtml(value.state)}" data-next-utc="${escapeHtml(value.dataset.nextUtc)}" data-precision="${escapeHtml(value.dataset.precision)}"`,
        `          data-status="${escapeHtml(value.dataset.status)}" data-checked-utc="${escapeHtml(data?.fetched_at_utc ?? "")}" data-unanswered="${value.unanswered ? "1" : ""}">`,
        `          <div class="card-header">`,
        `            <h3 class="card-title">${escapeHtml(card.title)}</h3>`,
        `            <span class="${value.badgeClass}">${escapeHtml(value.badgeText)}</span>`,
        `          </div>`,
        `          <div class="card-topic">${escapeHtml(card.topic)}</div>`,
        `          <div class="card-countdown${value.compact ? " is-text" : ""}">${escapeHtml(value.value)}</div>`,
        `          <div class="card-meta">`,
        `            <span class="last-checked">${escapeHtml(value.checked ?? "--")}</span>`,
        `          </div>`,
        `        </a>`,
        `        <button type="button" class="track" data-track="${escapeHtml(card.game)}" aria-pressed="false" hidden>`,
        `          <span class="track-mark" aria-hidden="true">☆</span>`,
        `          <span class="track-label">Track ${escapeHtml(card.title)}</span>`,
        `        </button>`,
        `      </div>`
    ];
    return lines.join(eol);
}

/** The event the page leads with, and why it was chosen. */
export interface NextDrop {
    card: AuthoredCard;
    value: CardValue;
    data: TrackerData | undefined;
    /**
     * Whether this is genuinely the next thing to happen.
     *
     * When nothing upcoming has a verified date, the page leads with the most recently verified change
     * instead — labelled as what it is. It never leads with nothing, and it never calls a past change
     * a coming one.
     */
    kind: "upcoming" | "latest";
}

/**
 * What the page should lead with.
 *
 * The soonest verified upcoming event, which is the first card of the `upcoming` group — the same
 * ordering `orderCards` already produces, so there is no second rule here that could disagree with the
 * grid below it. If no tracker answers a future-facing question today, the newest recently-updated
 * value takes its place under an honest heading. If nothing is verified at all, there is no drop.
 */
export function nextDrop<T extends { card: AuthoredCard; value: CardValue; data: TrackerData | undefined }>(cards: T[]): NextDrop | undefined {
    const ordered = orderCards(cards);
    const upcoming = ordered.find(entry => entry.value.group === "upcoming");
    if (upcoming) return { card: upcoming.card, value: upcoming.value, data: upcoming.data, kind: "upcoming" };
    const latest = ordered.find(entry => entry.value.group === "recent");
    if (latest) return { card: latest.card, value: latest.value, data: latest.data, kind: "latest" };
    return undefined;
}

/**
 * The lead block.
 *
 * The value is written as the absolute date or instant the source announced, never as a countdown. A
 * build happens up to six hours before a reader arrives, so "04d 12h" would be wrong on arrival; app.js
 * turns an exact instant into a live countdown in the browser, which is the same trade the cards make.
 *
 * A day-only value says so and stays a date. That rule is the whole reason this site is trusted, and
 * the most prominent thing on the homepage is the last place to bend it.
 */
export function renderNextDropHtml(drop: NextDrop | undefined, eol: string): string {
    if (!drop) {
        // Nothing verified anywhere. Rare, and it still has to read like a sentence someone wrote.
        return [
            `<section class="drop" data-nr-slot="next-drop">`,
            `        <p class="drop-eyebrow">Next drop</p>`,
            `        <h2 class="drop-game">Nothing verified right now</h2>`,
            `        <p class="drop-topic">No official source has answered any of the questions this site tracks. Every tracker below says what it knows.</p>`,
            `      </section>`
        ].join(eol);
    }

    const { card, value, data, kind } = drop;
    const exact = value.dataset.precision === "exact";
    const eyebrow = kind === "upcoming" ? "Next drop" : "Latest verified change";
    const lines = [
        `<section class="drop" data-nr-slot="next-drop" data-game="${escapeHtml(card.game)}" data-type="${escapeHtml(card.type)}"`,
        `        data-next-utc="${escapeHtml(value.dataset.nextUtc)}" data-precision="${escapeHtml(value.dataset.precision)}"`,
        `        data-status="${escapeHtml(value.dataset.status)}" data-kind="${kind}" data-checked-utc="${escapeHtml(data?.fetched_at_utc ?? "")}">`,
        `        <p class="drop-eyebrow">${escapeHtml(eyebrow)}</p>`,
        `        <h2 class="drop-game">${escapeHtml(card.title)}</h2>`,
        `        <p class="drop-topic">${escapeHtml(card.topic)}</p>`,
        `        <div class="drop-value${exact ? "" : " is-date"}">${escapeHtml(value.value)}</div>`
    ];
    if (!exact) {
        lines.push(`        <p class="drop-precision">Time not announced</p>`);
    }
    lines.push(
        `        <div class="drop-trust">`,
        `          <span class="${value.badgeClass}">${escapeHtml(value.badgeText)}</span>`,
        `          <span class="drop-source">${escapeHtml(data?.source_url ? sourceName(data.source_url) : "Official source")}</span>`,
        `          <span class="drop-checked">${escapeHtml(value.checked ?? "")}</span>`,
        `        </div>`,
        `        <div class="drop-actions">`,
        `          <a class="btn btn-primary" href="${escapeHtml(card.href)}">View ${escapeHtml(card.title)}</a>`,
        `          <button type="button" class="btn track track-wide" data-track="${escapeHtml(card.game)}" aria-pressed="false" hidden>`,
        `            <span class="track-mark" aria-hidden="true">☆</span>`,
        `            <span class="track-label">Track</span>`,
        `          </button>`,
        `        </div>`,
        `      </section>`
    );
    return lines.join(eol);
}

export interface HomeSummary {
    html: string;
    /** How many cards ended up in each group, for the build log. */
    counts: Record<CardGroup, number>;
    /** What the page led with, for the build log. */
    drop?: NextDrop;
}

/** Every anchor on the page. Which of them are cards is decided by class token, not by spelling. */
const ANCHOR_PATTERN = /<a\b[^>]*>[\s\S]*?<\/a>/g;

/**
 * The card blocks of a page, in document order.
 *
 * Matching `class="card"` literally would miss a card that gained a second class, and the cards are
 * replaced as one region: a card this step failed to recognise would be deleted from the page rather
 * than left alone. So anchors are matched loosely and filtered by class token, and the result is
 * checked against the parsed document — a card that exists but was not collected fails the build.
 */
export function cardBlocks(html: string): Array<{ block: string; index: number }> {
    const blocks = [...html.matchAll(ANCHOR_PATTERN)]
        .filter(match => cheerio.load(match[0])("a").first().hasClass("card"))
        .map(match => ({ block: match[0], index: match.index! }));
    const parsed = cheerio.load(html)("a.card").length;
    if (parsed !== blocks.length) {
        throw new Error(`home: found ${parsed} cards in the page but could only read ${blocks.length}`);
    }
    return blocks;
}

/**
 * Writes every card's verified value into the homepage and groups the cards by what the data says.
 *
 * Takes the authored HTML and a reader for published tracker files, and returns the HTML: nothing here
 * touches the filesystem, so the whole page is testable as a value.
 */
export function renderHomeHtml(html: string, read: (game: string, type: string) => TrackerData | undefined, now: Date = new Date()): HomeSummary {
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    const authored = cardBlocks(html);
    // A homepage with no cards is not a homepage. Asked here rather than left to the region, because a
    // page that declares a cards region would otherwise be allowed to render an empty one.
    if (authored.length === 0) throw new Error("home: no cards found");

    const cards = authored.map(match => {
        const card = readCard(match.block);
        const data = read(card.game, card.type);
        return { card, value: cardValue(data, now), data };
    });

    const counts: Record<CardGroup, number> = { upcoming: 0, recent: 0, unknown: 0 };
    for (const entry of cards) counts[entry.value.group]++;

    // The lead block first, and the card region measured afterwards: writing the lead changes every
    // offset after it, and a region located before that would splice into the wrong place.
    const drop = nextDrop(cards);
    const withDrop = replaceSlot(html, "next-drop", () => renderNextDropHtml(drop, eol), "home");

    // How much of the page the renderer may rewrite. A page that declares a cards region hands over
    // everything inside it, so headings and group wrappers can be emitted freely; a page that does not
    // gives up only the span from the first card to the last, and anything found between two cards is
    // content this rewrite would destroy, so it throws.
    const region = cardRegion(withDrop, cardBlocks(withDrop), "home");

    const parts: string[] = [];
    let group: CardGroup | undefined;
    for (const entry of orderCards(cards)) {
        if (entry.value.group !== group) {
            group = entry.value.group;
            // data-group lets app.js find a group when a card's state expires while the page is open.
            parts.push(`      <h2 class="group-heading" data-group="${group}">${escapeHtml(GROUP_HEADINGS[group])}</h2>`);
        }
        parts.push(renderCardHtml(entry.card, entry.value, entry.data, eol));
    }

    // In a region the renderer owns, the replacement starts on a line of its own. Where it replaces a
    // span that began with the first card, that card was already indented by the line it sat on, so the
    // first part sheds its own indent.
    const joined = parts.join(`${eol}${eol}`);
    const body = region.owned
        ? `${eol}${joined}${eol}${region.indent}`
        : joined.replace(/^ +/, "");
    return { html: withDrop.slice(0, region.start) + body + withDrop.slice(region.end), counts, drop };
}
