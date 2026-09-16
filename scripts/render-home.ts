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
import { TrackerData, escapeHtml, formatDate, formatDateTime, isFutureFacing, isUnanswered } from "./render-pages";

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
}

/**
 * Whether the published file has a value at all.
 *
 * Mirrors isDataUnavailable in app.js, including `confidence: "none"`: the pipeline uses it to say it
 * no longer stands behind the value, and a card must not badge that as LIVE.
 */
function hasNoValue(data: TrackerData | undefined): boolean {
    return !data || !data.nextEventUtc || data.confidence === "none" || data.status === "unavailable" || data.status === "fallback";
}

/**
 * What one card should say, from that tracker's published file alone.
 *
 * The decisions here are the ones app.js makes on load (renderCard), so hydration changes the form of a
 * value — a date becomes a live countdown — and never its meaning.
 */
export function cardValue(data: TrackerData | undefined, now: Date): CardValue {
    const checked = data?.fetched_at_utc ? `Checked ${formatDateTime(data.fetched_at_utc)}` : undefined;

    if (hasNoValue(data)) {
        return { group: "unknown", badgeText: "UNAVAILABLE", badgeClass: "badge badge-unavailable", value: "Data unavailable", compact: false, state: "unavailable", checked, unanswered: false };
    }
    const value = data as TrackerData & { nextEventUtc: string };

    if (isUnanswered(value, now)) {
        // The date it used to show has expired and nothing has replaced it. Never a countdown, never LIVE.
        return { group: "unknown", badgeText: "NO DATE", badgeClass: "badge badge-unavailable", value: "No official date announced", compact: true, state: "unavailable", checked, unanswered: true };
    }

    const at = Date.parse(value.nextEventUtc);
    const ahead = at > now.getTime();
    const stale = value.status === "stale";
    const badgeText = stale ? "STALE" : "LIVE";
    const badgeClass = stale ? "badge badge-stale" : "badge badge-live";
    const state = stale ? "stale" : "live";

    // A future-facing value whose moment has just passed: the next one arrives with the next refresh.
    // app.js says "Updating..." here, and the homepage says exactly the same rather than presenting a
    // passed instant as though it were still ahead.
    if (!ahead && isFutureFacing(value.type)) {
        return { group: "upcoming", badgeText, badgeClass, value: "Updating...", compact: false, state, checked, at, unanswered: false };
    }

    // A time is published only where the pipeline states the instant is exact; otherwise midnight UTC is
    // a storage artefact and the value is a date (the rule blocksFor applies on the tracker pages).
    const exact = value.precision === "exact";
    return {
        group: ahead && isFutureFacing(value.type) ? "upcoming" : "recent",
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
}

/** Reads the fixed parts of an authored card. Anything missing is template drift, so it throws. */
export function readCard(cardHtml: string): AuthoredCard {
    const card = cheerio.load(cardHtml)("a.card");
    const href = card.attr("href");
    const id = card.attr("id");
    const game = card.attr("data-game");
    const type = card.attr("data-type");
    const title = card.find(".card-title").text().trim();
    const topic = card.find(".card-topic").text().trim();
    if (!href || !id || !game || !type || !title || !topic) {
        throw new Error(`home: a card is missing href/id/data-game/data-type/title/topic (${cardHtml.slice(0, 80)})`);
    }
    return { href, id, game, type, title, topic };
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

/** One rendered card. The dataset carries what app.js needs to keep evaluating it as time passes. */
export function renderCardHtml(card: AuthoredCard, value: CardValue, data: TrackerData | undefined, eol: string): string {
    const lines = [
        `      <a href="${escapeHtml(card.href)}" class="card" id="${escapeHtml(card.id)}" data-game="${escapeHtml(card.game)}" data-type="${escapeHtml(card.type)}"`,
        `        data-state="${escapeHtml(value.state)}" data-next-utc="${escapeHtml(data?.nextEventUtc ?? "")}" data-precision="${escapeHtml(data?.precision ?? "")}"`,
        `        data-status="${escapeHtml(data?.status ?? "")}" data-unanswered="${value.unanswered ? "1" : ""}">`,
        `        <div class="card-header">`,
        `          <h3 class="card-title">${escapeHtml(card.title)}</h3>`,
        `          <span class="${value.badgeClass}">${escapeHtml(value.badgeText)}</span>`,
        `        </div>`,
        `        <div class="card-topic">${escapeHtml(card.topic)}</div>`,
        `        <div class="card-countdown${value.compact ? " is-text" : ""}">${escapeHtml(value.value)}</div>`,
        `        <div class="card-meta">`,
        `          <span class="last-checked">${escapeHtml(value.checked ?? "--")}</span>`,
        `        </div>`,
        `      </a>`
    ];
    return lines.join(eol);
}

export interface HomeSummary {
    html: string;
    /** How many cards ended up in each group, for the build log. */
    counts: Record<CardGroup, number>;
}

const CARD_PATTERN = /<a\b[^>]*class="card"[^>]*>[\s\S]*?<\/a>/g;

/**
 * Writes every card's verified value into the homepage and groups the cards by what the data says.
 *
 * Takes the authored HTML and a reader for published tracker files, and returns the HTML: nothing here
 * touches the filesystem, so the whole page is testable as a value.
 */
export function renderHomeHtml(html: string, read: (game: string, type: string) => TrackerData | undefined, now: Date = new Date()): HomeSummary {
    const matches = [...html.matchAll(CARD_PATTERN)];
    if (matches.length === 0) throw new Error("home: no cards found");
    const eol = html.includes("\r\n") ? "\r\n" : "\n";

    const cards = matches.map(match => {
        const card = readCard(match[0]);
        const data = read(card.game, card.type);
        return { card, value: cardValue(data, now), data };
    });

    const counts: Record<CardGroup, number> = { upcoming: 0, recent: 0, unknown: 0 };
    for (const entry of cards) counts[entry.value.group]++;

    const parts: string[] = [];
    let group: CardGroup | undefined;
    for (const entry of orderCards(cards)) {
        if (entry.value.group !== group) {
            group = entry.value.group;
            parts.push(`      <h2 class="group-heading">${escapeHtml(GROUP_HEADINGS[group])}</h2>`);
        }
        parts.push(renderCardHtml(entry.card, entry.value, entry.data, eol));
    }

    const start = matches[0].index!;
    const end = matches[matches.length - 1].index! + matches[matches.length - 1][0].length;
    // The first card was already indented by the line it sat on, so the first part sheds its own indent.
    const body = parts.join(`${eol}${eol}`).replace(/^ +/, "");
    return { html: html.slice(0, start) + body + html.slice(end), counts };
}
