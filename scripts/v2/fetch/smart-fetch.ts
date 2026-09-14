/**
 * Smart fetch: HTTP -> validate -> (render -> validate) -> normalized document.
 *
 *   conditional HTTP GET   304 or same text hash  -> "unchanged" (nothing downstream runs)
 *   validate content       usable                 -> document with normalized text + hash
 *   unusable, render helps -> browser render, validate again
 *   still unusable         -> "unusable" with the verdict; caller marks the source
 *
 * Per-source fetch state (ETag, Last-Modified, last text hash, failure streak)
 * is returned so the caller can persist it and pass it back next run.
 */
import { ContentExpectation, Verdict, VerdictCode, validateContent } from "./content-validation";
import { extractText, hashText, normalizeWhitespace } from "./text";
import { Transport, defaultTransport } from "./transport";

export interface SourceFetchState {
    etag?: string;
    lastModified?: string;
    /** Hash of the normalized text of the last usable fetch. */
    textHash?: string;
    lastFetchedAt?: string;
    lastUsableAt?: string;
    /** A VerdictCode; typed as string because it is persisted in knowledge files. */
    lastVerdict?: string;
    lastMode?: "http" | "browser";
    consecutiveFailures: number;
}

export interface FetchedDocument {
    url: string;
    finalUrl: string;
    status: number;
    fetchedAt: string;
    mode: "http" | "browser";
    contentType?: string;
    title: string;
    /** Normalized text (HTML) or the raw body (JSON/XML/text). */
    text: string;
    textHash: string;
    /** Raw response body; kept in memory only, never persisted. */
    body: string;
}

export interface FetchAttempt {
    mode: "http" | "browser";
    status: number;
    code: VerdictCode | "not-modified" | "error";
    reason: string;
    elapsedMs: number;
}

export interface SmartFetchOptions {
    expect: ContentExpectation;
    /** Allow a browser render when validation says it may help (default: HTML only). */
    allowRender?: boolean;
    previous?: SourceFetchState;
    transport?: Transport;
    /** Used in debug capture names and logs. */
    label?: string;
    now?: Date;
    timeoutMs?: number;
    /** Extra HTTP attempts after a transport error or a 5xx/0 status (default 2, like the V1 fetch layer). */
    retries?: number;
    /** Base backoff between HTTP attempts in ms, doubled per attempt (default 1000; tests pass 0). */
    retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
    return status === 0 || status >= 500;
}

export interface SmartFetchResult {
    outcome: "usable" | "unchanged" | "unusable";
    verdict?: Verdict;
    /** Present for "usable", and for "unchanged" when the body was received (same hash). */
    document?: FetchedDocument;
    state: SourceFetchState;
    attempts: FetchAttempt[];
    error?: string;
}

export const EMPTY_SOURCE_STATE: SourceFetchState = { consecutiveFailures: 0 };

function documentFrom(url: string, finalUrl: string, status: number, mode: "http" | "browser", body: string, contentType: string | undefined, expect: ContentExpectation, now: Date): FetchedDocument {
    let title = "";
    let text: string;
    if (expect.kind === "html") {
        const extracted = extractText(body);
        title = extracted.title;
        text = extracted.text;
    } else {
        text = normalizeWhitespace(body);
    }
    return { url, finalUrl, status, fetchedAt: now.toISOString(), mode, contentType, title, text, textHash: hashText(text), body };
}

export async function smartFetch(url: string, options: SmartFetchOptions): Promise<SmartFetchResult> {
    const transport = options.transport ?? defaultTransport();
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const previous = options.previous ?? EMPTY_SOURCE_STATE;
    const allowRender = options.allowRender ?? options.expect.kind === "html";
    const attempts: FetchAttempt[] = [];

    const failed = (verdict: Verdict | undefined, error: string | undefined, mode: "http" | "browser"): SmartFetchResult => ({
        outcome: "unusable",
        verdict,
        error,
        attempts,
        state: {
            ...previous,
            lastFetchedAt: nowIso,
            lastVerdict: verdict?.code ?? "http-error",
            lastMode: mode,
            consecutiveFailures: (previous.consecutiveFailures ?? 0) + 1
        }
    });

    const succeeded = (document: FetchedDocument, verdict: Verdict, headers: Record<string, string>): SmartFetchResult => {
        const unchanged = previous.textHash !== undefined && previous.textHash === document.textHash;
        return {
            outcome: unchanged ? "unchanged" : "usable",
            verdict,
            document,
            attempts,
            state: {
                etag: headers["etag"] ?? previous.etag,
                lastModified: headers["last-modified"] ?? previous.lastModified,
                textHash: document.textHash,
                lastFetchedAt: nowIso,
                lastUsableAt: nowIso,
                lastVerdict: "usable",
                lastMode: document.mode,
                consecutiveFailures: 0
            }
        };
    };

    // 1. Plain HTTP with conditional headers; bounded retries on transport errors and 5xx.
    const retries = options.retries ?? 2;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    let response;
    let lastError: string | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            response = await transport.get({ url, timeoutMs: options.timeoutMs, etag: previous.etag, lastModified: previous.lastModified });
            lastError = undefined;
            if (!isRetryableStatus(response.status) || attempt === retries) break;
            attempts.push({ mode: "http", status: response.status, code: "http-error", reason: `HTTP ${response.status}, retrying`, elapsedMs: response.elapsedMs });
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            attempts.push({ mode: "http", status: 0, code: "error", reason: lastError, elapsedMs: 0 });
            if (attempt === retries) break;
        }
        if (retryDelayMs > 0) await sleep(retryDelayMs * Math.pow(2, attempt));
    }
    if (!response || lastError !== undefined) {
        return failed(undefined, lastError ?? "no response", "http");
    }

    if (response.notModified) {
        attempts.push({ mode: "http", status: 304, code: "not-modified", reason: "server reports no change", elapsedMs: response.elapsedMs });
        return {
            outcome: "unchanged",
            attempts,
            state: { ...previous, lastFetchedAt: nowIso, lastVerdict: "usable", lastMode: "http", consecutiveFailures: 0 }
        };
    }

    const contentType = response.headers["content-type"];
    const httpVerdict = validateContent({ requestedUrl: url, finalUrl: response.finalUrl, status: response.status, contentType, body: response.body, expect: options.expect });
    attempts.push({ mode: "http", status: response.status, code: httpVerdict.code, reason: httpVerdict.reason, elapsedMs: response.elapsedMs });

    if (httpVerdict.usable) {
        const document = documentFrom(url, response.finalUrl, response.status, "http", response.body, contentType, options.expect, now);
        return succeeded(document, httpVerdict, response.headers);
    }

    // 2. Browser render when it can plausibly help.
    const canRender = allowRender && httpVerdict.renderMayHelp && typeof transport.render === "function"
        && (typeof transport.renderBudget !== "function" || transport.renderBudget() > 0);
    if (!canRender) {
        return failed(httpVerdict, undefined, "http");
    }

    let rendered;
    try {
        rendered = await transport.render!({
            url,
            timeoutMs: options.timeoutMs,
            label: options.label ?? url,
            validate: (html, status, finalUrl) => validateContent({ requestedUrl: url, finalUrl, status, body: html, expect: options.expect })
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ mode: "browser", status: 0, code: "error", reason: message, elapsedMs: 0 });
        return failed(httpVerdict, message, "browser");
    }

    attempts.push({ mode: "browser", status: rendered.status, code: rendered.verdict.code, reason: rendered.verdict.reason, elapsedMs: rendered.elapsedMs });
    if (!rendered.verdict.usable) {
        return failed(rendered.verdict, undefined, "browser");
    }

    const document = documentFrom(url, rendered.finalUrl, rendered.status, "browser", rendered.html, "text/html", options.expect, now);
    // A rendered document has no validators; keep the previous ETag/Last-Modified so the next HTTP probe stays conditional.
    return succeeded(document, rendered.verdict, {});
}
