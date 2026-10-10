/**
 * Call of Duty: Warzone last patch (server-rendered HTML, deterministic parse).
 *
 * Source: the official Call of Duty patch notes page. It shows one current card
 * per game (Warzone, Black Ops, Modern Warfare betas). The Warzone card is the
 * `.card-inner` that holds `li.game-tile.warzone`; its `div.news-published`
 * carries the last update day in `data-date` (the visible "Last updated" text is
 * filled in by JavaScript, so the attribute is read), and its link is the patch
 * notes article.
 *
 * The articles are living documents: Activision adds dated update sections
 * ("FRIDAY AUGUST 28") to the same article, and the card's `data-date` follows
 * the newest one. Identity is therefore the article slug plus the update day, so
 * every in-place update is its own event.
 *
 * Precision: the page states a day only, with no time or time zone, so events
 * are stored at day precision (published as midnight UTC of that day, as V1 did).
 *
 * Beneath the card the page carries a "View past patch notes" accordion, and that
 * is this topic's history: previous articles with their dates and links, in the
 * same response. V1's mistake was reading that list for the *headline* and
 * publishing a date 16 days old. The current card is authoritative for what the
 * latest patch is; the accordion is authoritative for what came before it.
 *
 * The page is fetched as text, so any change is examined; parsing is
 * deterministic and no model is involved. Evidence names the fetched page; the
 * claim quotes, verbatim, the slice of the page from the Warzone tile through its
 * date element, and carries the article link for visitors.
 *
 * Access note: on 2026-09-16 this site reset connections from the development
 * machine while the CI runners still reached it. Production fetches from CI.
 * Nothing here works around blocking.
 */
import * as cheerio from "cheerio";
import { failureKindFromFetch } from "../reasons";
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
import { eventKey } from "../identity";

export const WARZONE_PATCH_NOTES_URL = "https://www.callofduty.com/patchnotes";
const SITE = "https://www.callofduty.com";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export interface WarzoneUpdate {
    /** Article slug plus update day, e.g. "call-of-duty-bo7-warzone-season-05-reloaded-patch-notes-2026-08-28". */
    identity: string;
    title: string;
    /** Midnight UTC of the update day (day precision). */
    at: string;
    /** `data-date` exactly as the page gives it, e.g. "August 28, 2026". */
    dataDate: string;
    url: string;
    /** The page from the Warzone tile through its date element, verbatim. */
    excerpt: string;
}

/**
 * One patch notes article from the page's own "View past patch notes" accordion.
 *
 * No `excerpt`: the accordion gives a title, a date and a link, and the link is what a reader wants.
 * A verbatim slice of list markup would be evidence nobody is shown, and `evidenceFor` ignores a
 * deterministic quote anyway — the article URL is what ends up beside the row.
 */
export interface WarzoneArchiveEntry {
    /** The same scheme as the card's: article slug plus update day. */
    identity: string;
    title: string;
    /** Midnight UTC of the publication day (day precision, as the page states it). */
    at: string;
    /** The date exactly as the accordion prints it, e.g. "August 12, 2026". */
    published: string;
    url: string;
}

/** "August 28, 2026" as midnight UTC of that day, or undefined when it is not a real calendar day in that form. */
export function parseCardDate(text: string): string | undefined {
    const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text.trim());
    if (!m) return undefined;
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (month < 0 || day < 1 || day > 31) return undefined;
    const date = new Date(Date.UTC(year, month, day));
    return date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString() : undefined;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The current Warzone card. Throws when the page does not have exactly one Warzone card with a date and an article link. */
export function parseWarzoneUpdate(html: string): WarzoneUpdate {
    const $ = cheerio.load(html);
    const cards = $(".card-inner").filter((_, el) => $(el).find("li.game-tile.warzone").length > 0);
    if (cards.length !== 1) throw new Error(`Expected one Warzone card on the Call of Duty patch notes page, found ${cards.length}`);
    const card = cards.first();
    const dataDate = card.find("div.news-published[data-date]").first().attr("data-date");
    if (!dataDate) throw new Error("The Warzone card has no data-date");
    const at = parseCardDate(dataDate);
    if (!at) throw new Error(`Unrecognized Warzone card date ${JSON.stringify(dataDate)}`);
    const href = card.find("a[href^=\"/patchnotes/\"]").first().attr("href");
    const slug = href ? /^\/patchnotes\/\d{4}\/\d{2}\/([a-z0-9-]+)\/?$/.exec(href)?.[1] : undefined;
    if (!href || !slug) throw new Error("The Warzone card has no patch notes article link");
    const labelledBy = card.find("a[aria-labelledby]").first().attr("aria-labelledby");
    const titleById = labelledBy ? $(`[id="${labelledBy.replace(/"/g, "")}"]`).first().text().replace(/\s+/g, " ").trim() : "";
    const title = titleById || card.find("h1, h2, h3, h4").last().text().replace(/\s+/g, " ").trim() || "Call of Duty: Warzone Patch Notes";

    // Verbatim excerpt: from the Warzone tile element to the end of its date element, inside the same card.
    const tileMatch = /<li\b[^>]*class="[^"]*\bgame-tile warzone\b[^"]*"[^>]*>/.exec(html);
    if (!tileMatch) throw new Error("The Warzone tile cannot be quoted verbatim");
    const rest = html.slice(tileMatch.index);
    const dateTag = new RegExp(`<div\\b[^>]*data-date="${escapeRegExp(dataDate)}"[^>]*>`).exec(rest);
    const nextCard = rest.indexOf("card-inner");
    if (!dateTag || (nextCard !== -1 && dateTag.index > nextCard)) throw new Error("The Warzone card date cannot be quoted verbatim");
    const excerpt = rest.slice(0, dateTag.index + dateTag[0].length);

    return { identity: `${slug}-${at.slice(0, 10)}`, title, at, dataDate, url: `${SITE}${href}`, excerpt };
}

/**
 * How many archived patch notes the page keeps.
 *
 * `render-data-blocks` draws twelve rows of history, so storing more would be bytes written on every
 * run to show nothing. The accordion carries about twice that.
 */
export const KEPT_ARCHIVE = 12;

/**
 * The Warzone patch notes the page's own archive lists, newest first.
 *
 * The card at the top of the page is the current patch, and beneath it Activision publishes a "View
 * past patch notes" accordion: a list of previous articles with their titles, their publication dates
 * and their links, scoped to the Warzone tile. All of it is in the response this adapter already
 * fetches, so the page's history costs no request, no crawl and no model call.
 *
 * It is read from the accordion that belongs to the Warzone tile, never from every accordion on the
 * page: the same markup carries Black Ops' archive a few hundred lines further down, and merging the
 * two would publish another game's patches as Warzone's.
 *
 * Dates are day-precision, as the card's are — the page states a day with no time or zone, and
 * inventing one would be our value rather than Activision's.
 */
export function parseWarzoneArchive(html: string, limit = KEPT_ARCHIVE): WarzoneArchiveEntry[] {
    const $ = cheerio.load(html);
    // The tile that says which game a section is for sits beside the accordion, not inside it, so the
    // accordion is matched by walking out to the nearest ancestor that names a game and checking that
    // the game it names is Warzone and only Warzone. Looking inside finds nothing; taking the first
    // accordion on the page would take whichever Activision happens to put first.
    const accordions = $(".post-grid-accordion").filter((_, el) => {
        for (let node = $(el).parent(); node.length > 0; node = node.parent()) {
            const tiles = node.find("li.game-tile");
            if (tiles.length === 0) continue;
            return tiles.length === 1 && tiles.first().hasClass("warzone");
        }
        return false;
    });
    if (accordions.length !== 1) return [];
    const entries: WarzoneArchiveEntry[] = [];
    const seen = new Set<string>();
    accordions.first().find(".post-grid-accordion__list li").each((_, li) => {
        const item = $(li);
        const href = item.find('a[href^="/patchnotes/"]').first().attr("href");
        const slug = href ? /^\/patchnotes\/\d{4}\/\d{2}\/([a-z0-9-]+)\/?$/.exec(href)?.[1] : undefined;
        const published = item.find(".pub-date").first().text().replace(/\s+/g, " ").trim();
        const title = item.find(".post-title").first().text().replace(/\s+/g, " ").trim();
        if (!href || !slug || !published || !title) return;
        const at = parseCardDate(published);
        if (!at) return;
        // The same identity scheme the current card uses, so an article that moves out of the archive
        // and into the card (or back) is recognised as the event it already was rather than a new one.
        const identity = `${slug}-${at.slice(0, 10)}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        entries.push({ identity, title, at, published, url: `${SITE}${href}` });
    });
    return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/** `transport` is injectable for tests; production uses the default HTTP transport (no rendering). */
export function createWarzonePatchAdapter(transport?: Transport): Adapter {
    return async ({ game, topic, now, getSourceState, knowledge }) => {
        const source = game.sources.find(s => s.id === topic.sourceId);
        if (!source) throw new Error(`Source ${topic.sourceId} is not configured for ${game.id}`);

        // Validators and hashes belong to a URL: if the configured source moved, start from nothing.
        const stored = getSourceState(source.id);
        const previous = stored && stored.url === source.url ? stored : undefined;

        const fetched = await smartFetch(source.url, { expect: { kind: "text", minWords: 20, markers: ["Patch Notes"] }, allowRender: false, previous, transport, label: `${game.id}-${topic.type}`, now });
        const sourceStates: SourceState[] = [{ id: source.id, url: source.url, ...fetched.state }];
        if (fetched.outcome === "unusable") {
            return { events: [], failure: fetched.error ?? fetched.verdict?.reason ?? "fetch failed", failureKind: failureKindFromFetch(fetched), sourceStates };
        }
        const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };
        // An unchanged response still gets read when the body came down with it.
        //
        // `unchanged` covers two different things: a 304, which has no body at all, and a 200 whose
        // hash matched, which has one. Returning early for both was right when a run imported only the
        // current card — there was nothing new to learn from bytes we had seen before. It is wrong now:
        // on the first deploy after this change the store holds no archive, and the page reads as
        // unchanged until Activision next patches anything. Where the body is in our hands, parsing it
        // imports the history for no request at all, and the upserts are idempotent.
        //
        // A true 304 has no body and cannot be read. The next change to the page — any of the three
        // games patching — completes the import, and nothing is published wrongly in the interim.
        const unchanged = fetched.outcome === "unchanged";
        if (unchanged && !fetched.document) {
            return { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 } };
        }

        const page = fetched.document!;
        let update: WarzoneUpdate;
        try {
            update = parseWarzoneUpdate(page.body);
        } catch (error) {
            // A page that cannot vouch for the Warzone card is a source failure. Keep the last good hash and drop
            // validators, so the same content is examined again next run instead of reading as "unchanged".
            sourceStates[0] = {
                ...sourceStates[0],
                etag: undefined,
                lastModified: undefined,
                textHash: previous?.textHash,
                lastUsableAt: previous?.lastUsableAt,
                lastVerdict: "parse-error",
                consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
            };
            return { events: [], failure: error instanceof Error ? error.message : String(error), failureKind: "extraction-failed", sourceStates };
        }

        // The patches behind the current one, from the page's own "View past patch notes" accordion.
        // Same response, same fetch: history here costs nothing that the headline did not already cost.
        const archive = parseWarzoneArchive(page.body).filter(entry => entry.identity !== update.identity);

        // Evidence only where this update day is new to the knowledge file. The card carries a verbatim
        // excerpt; an archive row carries its article link, which is the evidence a reader is actually
        // shown and what `blocksFor` requires before it will list a past event at all.
        const evidenced = (identity: string, at: string) =>
            knowledge.claims.some(c => c.eventKey === eventKey(game.id, topic.type, identity) && c.field === "at" && c.value === at);

        const key = eventKey(game.id, topic.type, update.identity);
        const known = evidenced(update.identity, update.at);
        const claims: Claim[] = known ? [] : [{
            id: sha(`${page.textHash}|${key}|at|${update.at}`).slice(0, 24),
            documentId: page.textHash,
            eventKey: key,
            field: "at",
            value: update.at,
            method: "deterministic",
            quote: update.excerpt,
            linkUrl: update.url,
            extractedAt: page.fetchedAt
        }];
        for (const entry of archive) {
            if (evidenced(entry.identity, entry.at)) continue;
            const entryKey = eventKey(game.id, topic.type, entry.identity);
            claims.push({
                id: sha(`${page.textHash}|${entryKey}|at|${entry.at}`).slice(0, 24),
                documentId: page.textHash,
                eventKey: entryKey,
                field: "at",
                value: entry.at,
                method: "deterministic",
                // No quote: the accordion's markup is a list item nobody is shown, and a deterministic
                // quote is ignored for display anyway. The article link is the evidence that reaches
                // the reader.
                linkUrl: entry.url,
                extractedAt: page.fetchedAt
            });
        }
        const documents: Document[] = claims.length === 0 ? [] : [{
            id: page.textHash,
            url: page.finalUrl,
            sourceId: source.id,
            fetchedAt: page.fetchedAt,
            title: "Call of Duty patch notes",
            fetchMode: page.mode,
            confidence: Confidence.High
        }];
        return {
            // Day precision: the page states no time or time zone.
            events: [
                { identity: update.identity, label: update.title, status: "observed", at: update.at, precision: "day" },
                ...archive.map(entry => ({ identity: entry.identity, label: entry.title, status: "observed" as const, at: entry.at, precision: "day" as const }))
            ],
            // The current card is authoritative: a date corrected backward retires the later update it no longer names.
            currentIdentity: update.identity,
            documents,
            claims,
            confidence: Confidence.High,
            sourceStates,
            fetch,
            // HTML parsed by code: never sent to a model. A response we had already seen still counts
            // as unchanged work even when it is re-read for the archive it carries.
            work: unchanged
                ? { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 }
                : { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
        };
    };
}
