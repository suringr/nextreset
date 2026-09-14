/**
 * Content validation: decides whether a fetched response is actually usable.
 *
 * An HTTP 200 is not enough. The audit found four ways a "successful" fetch was
 * worthless: bot-challenge pages (Cloudflare), "enable JavaScript" shells, empty
 * JavaScript application shells, and redirects to a homepage. Every rule here is
 * deterministic and explains itself in `reason`, and the verdict says whether a
 * rendered (browser) fetch might help.
 */
import { XMLParser } from "fast-xml-parser";
import { ExtractedText, extractText } from "./text";

export type ContentKind = "html" | "json" | "xml" | "text";

export type VerdictCode =
    | "usable"
    | "challenge"
    | "enable-js"
    | "js-shell"
    | "redirect"
    | "insufficient"
    | "http-error"
    | "parse-error"
    | "empty";

export interface ContentExpectation {
    kind: ContentKind;
    /** Minimum visible words for HTML/text to count as content (default 120). */
    minWords?: number;
    /** Case-insensitive strings of which at least one must appear in the text. */
    markers?: string[];
    /** Hosts the final URL may be on; defaults to the requested host (www-insensitive). */
    allowHosts?: string[];
    /** Accept a redirect to the site root. */
    allowHomepage?: boolean;
}

export interface ValidationInput {
    requestedUrl: string;
    finalUrl: string;
    status: number;
    contentType?: string;
    body: string;
    expect: ContentExpectation;
}

export interface VerdictSignals {
    status: number;
    finalHost: string;
    redirected: boolean;
    wordCount: number;
    bodyWordCount: number;
    scriptCount: number;
    scriptRatio: number;
    challengeMarker?: string;
    markersFound: string[];
}

export interface Verdict {
    usable: boolean;
    code: VerdictCode;
    reason: string;
    /** A browser render could plausibly turn this into usable content. */
    renderMayHelp: boolean;
    signals: VerdictSignals;
    /** Present for HTML/text inputs that were parsed. */
    extracted?: ExtractedText;
}

const DEFAULT_MIN_WORDS = 120;

/** Lower-cased substrings that identify bot-challenge / access-control interstitials. */
export const CHALLENGE_MARKERS = [
    "cf_chl",
    "cf-chl",
    "__cf_chl",
    "cf_challenge",
    "challenge-platform",
    "just a moment...",
    "checking your browser",
    "attention required! | cloudflare",
    "verifying you are human",
    "verify you are human",
    "pardon our interruption",
    "px-captcha",
    "_pxappid",
    "datadome",
    "incapsula",
    "hcaptcha.com",
    "reference #18."
];

const ENABLE_JS_MARKERS = [
    "enable javascript",
    "javascript is required",
    "javascript to run this app",
    "turn on javascript"
];

export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}

function pathOf(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return "";
    }
}

function findMarker(haystackLower: string, markers: string[]): string | undefined {
    return markers.find(m => haystackLower.includes(m));
}

export function validateContent(input: ValidationInput): Verdict {
    const { requestedUrl, finalUrl, status, body, expect } = input;
    const requestedHost = hostOf(requestedUrl);
    const finalHost = hostOf(finalUrl || requestedUrl);
    const allowedHosts = (expect.allowHosts && expect.allowHosts.length > 0 ? expect.allowHosts : [requestedHost])
        .map(h => h.toLowerCase().replace(/^www\./, ""));
    const redirected = finalHost !== requestedHost || pathOf(finalUrl || requestedUrl) !== pathOf(requestedUrl);
    const bodyLower = body.toLowerCase();

    const base: VerdictSignals = {
        status,
        finalHost,
        redirected,
        wordCount: 0,
        bodyWordCount: 0,
        scriptCount: 0,
        scriptRatio: 0,
        markersFound: []
    };

    const verdict = (code: VerdictCode, reason: string, renderMayHelp: boolean, signals: VerdictSignals, extracted?: ExtractedText): Verdict =>
        ({ usable: code === "usable", code, reason, renderMayHelp, signals, extracted });

    if (!body || body.trim().length === 0) {
        return verdict("empty", `empty body (HTTP ${status})`, status === 403 || status === 429 || status === 200, base);
    }

    // Challenge pages come with any status (403 from Cloudflare, 200 from a rendered interstitial).
    const challengeMarker = findMarker(bodyLower, CHALLENGE_MARKERS);
    if (challengeMarker) {
        return verdict("challenge", `bot-challenge page detected (marker "${challengeMarker}", HTTP ${status})`, true, { ...base, challengeMarker });
    }

    if (status >= 400 || status === 0) {
        return verdict("http-error", `HTTP ${status}`, status === 403 || status === 429, base);
    }

    // Unexpected destination: another host, or the site root when a deeper page was requested.
    if (!allowedHosts.includes(finalHost)) {
        return verdict("redirect", `redirected to unexpected host ${finalHost}`, false, base);
    }
    const requestedPath = pathOf(requestedUrl).replace(/\/+$/, "");
    const finalPath = pathOf(finalUrl || requestedUrl).replace(/\/+$/, "");
    if (requestedPath !== "" && finalPath === "" && !expect.allowHomepage) {
        return verdict("redirect", `redirected to the site homepage (${finalUrl})`, false, base);
    }
    if (/\/(login|signin|sign-in|account\/login)(\/|$|\?)/i.test(finalPath) && !/\/(login|signin|sign-in)/i.test(requestedPath)) {
        return verdict("redirect", `redirected to a login page (${finalUrl})`, false, base);
    }

    if (expect.kind === "json") {
        const trimmed = body.trimStart();
        if (trimmed.startsWith("<")) {
            return verdict("parse-error", "expected JSON but received markup", false, base);
        }
        try {
            const parsed = JSON.parse(body);
            if (parsed === null || (typeof parsed !== "object")) {
                return verdict("parse-error", "JSON is not an object or array", false, base);
            }
            return verdict("usable", "valid JSON", false, base);
        } catch (error) {
            return verdict("parse-error", `invalid JSON: ${(error as Error).message}`, false, base);
        }
    }

    if (expect.kind === "xml") {
        try {
            const parsed = new XMLParser({ ignoreAttributes: false }).parse(body);
            const items = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? parsed?.urlset?.url ?? parsed?.sitemapindex?.sitemap;
            if (items === undefined) {
                return verdict("parse-error", "XML parsed but is not an RSS/Atom feed or sitemap", false, base);
            }
            return verdict("usable", "valid feed/sitemap XML", false, base);
        } catch (error) {
            return verdict("parse-error", `invalid XML: ${(error as Error).message}`, false, base);
        }
    }

    // html / text
    const extracted = extractText(body);
    const minWords = expect.minWords ?? DEFAULT_MIN_WORDS;
    const signals: VerdictSignals = {
        ...base,
        wordCount: extracted.wordCount,
        bodyWordCount: extracted.bodyWordCount,
        scriptCount: extracted.scriptCount,
        scriptRatio: extracted.scriptRatio,
        markersFound: []
    };

    const enableJs = extracted.noscriptAsksForJs || findMarker(bodyLower, ENABLE_JS_MARKERS) !== undefined;
    const thin = extracted.bodyWordCount < minWords;

    if (thin && enableJs) {
        return verdict("enable-js", `page asks for JavaScript and has only ${extracted.bodyWordCount} visible words`, true, signals, extracted);
    }
    if (thin && (extracted.scriptCount >= 3 || extracted.scriptRatio > 0.3)) {
        return verdict("js-shell", `JavaScript application shell: ${extracted.bodyWordCount} visible words, ${extracted.scriptCount} scripts`, true, signals, extracted);
    }
    if (thin) {
        return verdict("insufficient", `only ${extracted.bodyWordCount} visible words (minimum ${minWords})`, extracted.scriptCount > 0, signals, extracted);
    }

    if (expect.markers && expect.markers.length > 0) {
        const textLower = extracted.text.toLowerCase();
        const found = expect.markers.filter(m => textLower.includes(m.toLowerCase()));
        signals.markersFound = found;
        if (found.length === 0) {
            return verdict("insufficient", `none of the expected markers found (${expect.markers.join(", ")})`, extracted.scriptCount > 0, signals, extracted);
        }
    }

    return verdict("usable", `${extracted.wordCount} words of content`, false, signals, extracted);
}
