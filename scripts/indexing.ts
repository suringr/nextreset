/**
 * Which pages are worth indexing, decided by the data rather than by hand.
 *
 * A tracker page exists to answer one question. When it can answer it, the page is the best thing on
 * the web for that question: a verified date, the official source, the times it was checked. When it
 * cannot — the source has never been read successfully, or the date it used to publish has expired and
 * nothing has replaced it — the page is honest but thin, and asking Google to index it is asking to be
 * judged on the page that says the least.
 *
 * So the rule is the one the renderer already applies to the headline. If the page publishes a value,
 * it is indexed. If it publishes "Data unavailable" or "No official date announced", it carries
 * `noindex, follow`: not in the index, still crawled, its links still followed to the pages that do
 * answer something. Fortnite is that page today.
 *
 * Nothing is hidden from a reader by this. The page stays exactly where it was, says exactly what it
 * knows, and returns to the index by itself on the next build after a source answers.
 *
 * The same decision drives the sitemap: a URL that says `noindex` has no business being submitted for
 * indexing, and asking for both at once is the kind of contradictory signal that teaches a crawler to
 * trust neither.
 */
import * as cheerio from "cheerio";
import { TrackerData, hasVerifiedValue, isUnanswered } from "./render-pages";

export type IndexState = "index" | "noindex";

export interface IndexDecision {
    state: IndexState;
    /** Why, for the build log. Never published: a reader is told what is known, not how it was judged. */
    reason: string;
}

/** The robots directive for a page that should not be indexed. Crawled and followed, just not listed. */
export const NOINDEX_TAG = `<meta name="robots" content="noindex, follow">`;

/**
 * Whether a tracker page answers its question today.
 *
 * Deliberately the same three cases blocksFor renders, in the same order, so the tag and the headline
 * can never disagree: no data, an expired question, or a value.
 */
export function indexStateFor(data: TrackerData | undefined, now: Date): IndexDecision {
    if (!hasVerifiedValue(data)) {
        return { state: "noindex", reason: "no verified value to publish" };
    }
    if (isUnanswered(data, now)) {
        return { state: "noindex", reason: "the question has no answer right now" };
    }
    return { state: "index", reason: "publishes a verified value" };
}

/**
 * Whether a page has already asked not to be indexed, in its own markup.
 *
 * Parsed rather than pattern-matched: attribute order, quoting and spacing are all the author's choice,
 * and `<meta content="noindex, follow" name="robots">` is the same instruction written the other way
 * round. Missing it would put the page back in the sitemap while it asks to stay out.
 */
/** The directives that mean "do not index this": `none` is shorthand for `noindex, nofollow`. */
const NOINDEX_DIRECTIVES = new Set(["noindex", "none"]);

export function declaresNoindex(html: string): boolean {
    const $ = cheerio.load(html);
    // Every matching tag, not the first: a crawler combines the directives it finds and obeys the most
    // restrictive, so an index tag followed by a noindex one is a noindex page. Each tag's content is a
    // comma-separated list, read as tokens so a value that merely contains the word does not count.
    return $(`meta[name="robots" i]`).toArray().some(node =>
        ($(node).attr("content") ?? "")
            .toLowerCase()
            .split(",")
            .map(directive => directive.trim())
            .some(directive => NOINDEX_DIRECTIVES.has(directive))
    );
}

/**
 * Pages with no tracker of their own.
 *
 * The homepage carries every value the site has; About and Privacy are what a visitor (and a reviewer)
 * reads to decide whether to trust it. Those are worth indexing — but "has no tracker" is not the same
 * as "should be indexed", and assuming it was submitted the 404 page, which says noindex in its own
 * head. A page that has already answered this question answers it here too.
 */
export function staticPageDecision(html: string): IndexDecision {
    return declaresNoindex(html)
        ? { state: "noindex", reason: "the page asks not to be indexed" }
        : { state: "index", reason: "not a tracker page" };
}
