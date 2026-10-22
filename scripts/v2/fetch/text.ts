/**
 * Normalized text extraction and hashing for fetched documents.
 *
 * The text is what downstream steps (validation, change detection, and later
 * AI extraction) operate on. It is deterministic for a given HTML input, so its
 * hash can tell "unchanged since last run" apart from cosmetic markup churn.
 */
import * as cheerio from "cheerio";
import { createHash } from "crypto";

export interface ExtractedText {
    /** <title>, falling back to og:title, then the first h1. */
    title: string;
    /** Normalized visible text: main content when the page has a substantial one, else the whole body. */
    text: string;
    /** Word count of `text`. */
    wordCount: number;
    /** Word count of the whole body, used for shell detection regardless of main-content selection. */
    bodyWordCount: number;
    scriptCount: number;
    /** Bytes inside <script> elements divided by total HTML bytes (0..1). */
    scriptRatio: number;
    /** A <noscript> block asks the visitor to enable JavaScript. */
    noscriptAsksForJs: boolean;
}

const REMOVE_SELECTOR = "script, style, noscript, template, iframe, svg, canvas, link, meta";
const MAIN_SELECTOR = "main, article, [role=main], #main-content, .article-body, .article-content";
const MIN_MAIN_WORDS = 100;
/** Elements whose boundaries separate words even when the markup has no whitespace between them. */
const BLOCK_SELECTOR = "p, div, li, ul, ol, dl, dt, dd, td, th, tr, table, thead, tbody, h1, h2, h3, h4, h5, h6, br, hr, section, article, aside, header, footer, nav, main, blockquote, pre, figure, figcaption, details, summary, form, label, option, time";

export function normalizeWhitespace(text: string): string {
    return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

export function countWords(text: string): number {
    return text.length === 0 ? 0 : text.split(" ").filter(Boolean).length;
}

export function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The hash of a page's own content, for deciding whether it changed enough to be read again.
 *
 * Some official pages end with material that is not theirs: Riot's support articles close with a
 * "Related Articles" list that rotates as Riot edits *other* articles. The full text hash changes with
 * it, so a schedule nobody touched was sent to the model again — six LoL documents between 15 September
 * and 14 October 2026 produced the identical 24 claims.
 *
 * `markers` names where that trailing material starts. The text is cut at the LAST occurrence of a
 * marker, and only when that occurrence sits in the second half of the text: a marker near the top is
 * navigation or a heading, and cutting there could hide the article itself. With no marker, or none in
 * a safe position, this is the full-text hash, so a page this rule does not understand behaves exactly
 * as before. Everything before the cut still counts — a one-character edit to the schedule changes it.
 */
export function contentFingerprint(text: string, markers: readonly string[] = []): string {
    let cut = text.length;
    for (const marker of markers) {
        if (!marker) continue;
        const at = text.lastIndexOf(marker);
        if (at >= text.length / 2 && at < cut) cut = at;
    }
    return hashText(cut === text.length ? text : text.slice(0, cut).trimEnd());
}

export function extractText(html: string): ExtractedText {
    const $ = cheerio.load(html);

    let scriptBytes = 0;
    let scriptCount = 0;
    $("script").each((_, el) => {
        scriptCount++;
        scriptBytes += ($(el).html() || "").length;
    });
    const scriptRatio = html.length > 0 ? Math.min(1, scriptBytes / html.length) : 0;

    const noscriptText = normalizeWhitespace($("noscript").text()).toLowerCase();
    const noscriptAsksForJs = /enable javascript|javascript is required|javascript to run|turn on javascript/.test(noscriptText);

    const title = normalizeWhitespace(
        $("title").first().text() ||
        $("meta[property='og:title']").attr("content") ||
        $("h1").first().text() ||
        ""
    );

    $(REMOVE_SELECTOR).remove();

    // Compact markup such as <td>Patch</td><td>26.19</td> must not read as "Patch26.19".
    $(BLOCK_SELECTOR).each((_, el) => {
        $(el).before(" ");
        $(el).after(" ");
    });

    const bodyText = normalizeWhitespace($("body").text() || $.root().text());
    const bodyWordCount = countWords(bodyText);

    let text = bodyText;
    const main = $(MAIN_SELECTOR).first();
    if (main.length > 0) {
        const mainText = normalizeWhitespace(main.text());
        if (countWords(mainText) >= MIN_MAIN_WORDS) text = mainText;
    }

    return {
        title,
        text,
        wordCount: countWords(text),
        bodyWordCount,
        scriptCount,
        scriptRatio,
        noscriptAsksForJs
    };
}
