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

export function normalizeWhitespace(text: string): string {
    return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

export function countWords(text: string): number {
    return text.length === 0 ? 0 : text.split(" ").filter(Boolean).length;
}

export function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
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
