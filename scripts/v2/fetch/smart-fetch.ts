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
    /** See `SourceState.contentFingerprint`; computed by the caller, carried here. */
    contentFingerprint?: string;
    lastFetchedAt?: string;
    lastUsableAt?: string;
    /** A VerdictCode; typed as string because it is persisted in knowledge files. */
    lastVerdict?: string;
    lastMode?: "http" | "browser";
    consecutiveFailures: number;
    /**
     * The extraction capability that last read this source's content in full.
     *
     * A conditional GET is the right default: when nothing upstream changed, nothing downstream needs to
     * run. But it makes an adapter's reach a property of *when it shipped*. Teach an adapter to read more
     * out of the same response — a release history that was always in the manifest, an archive that was
     * always under the card — and it can only ever apply that to content it has not seen. A source that is
     * quiet keeps answering 304, a 304 has no body to re-read, and the new capability waits indefinitely
     * for an upstream change that has nothing to do with it.
     *
     * So an adapter declares the version of its own extraction, and `smartFetch` carries the last one that
     * ran here. When the adapter's version is ahead, the caller asks for one unconditional fetch, reads the
     * whole representation, and records the new version. That is one request per source per capability
     * change, and not an extra one: it replaces the conditional request the schedule was making anyway.
     *
     * `smartFetch` only preserves this field. The adapter sets it, and only after the extraction it names
     * has actually succeeded — a version recorded on a parse that threw would make the gap permanent.
     */
    extractionVersion?: number;
    /**
     * Unconditional reads already spent on a version that has not yet succeeded.
     *
     * Recording the version only on success buys a transient failure another attempt, and buys a
     * *permanent* failure an unbounded one: a source whose shape changed under the parser would be
     * downloaded in full on every run for the rest of time, which is exactly the recurring cost this
     * mechanism exists to avoid (Codex, #68). The attempt is counted before the body is parsed, so a
     * transport error, a 5xx or a throw all consume one.
     *
     * Keyed by version so a later capability starts with a full budget rather than inheriting an
     * exhausted one.
     */
    extractionAttempts?: { version: number; tries: number };
}

/**
 * How many unconditional reads a single capability version may spend before giving up.
 *
 * Small on purpose. The backfill is an optimisation -- the history arrives anyway on the next genuine
 * change to the source -- so the budget only needs to cover a flake or two, not to keep trying.
 */
export const MAX_EXTRACTION_ATTEMPTS = 3;

/**
 * Whether to ask for the body although nothing has changed.
 *
 * Three conditions, each closing a different hole: `settled` stops once the backfill has landed, the
 * version stops a backfill that can never land, and the attempt count stops one that fails every time.
 * Shared rather than written out in each adapter, because two copies of a bound are one copy away from
 * disagreeing.
 */
export function shouldReadInFull(previous: SourceFetchState | undefined, version: number, settled: boolean): boolean {
    return remainingExtractionReads(previous, version, settled) > 0;
}

/**
 * How many validator-free requests this capability may still issue.
 *
 * The budget is checked once, before the call, but one `smartFetch` can issue several: a transport
 * error or a 5xx is retried, and under `unconditional` every retry is also validator-free. Checking
 * before and charging after let a run with one attempt already spent send three more (Codex, #68). The
 * caller passes this to `retries` so a single call cannot overspend what is left.
 */
export function remainingExtractionReads(previous: SourceFetchState | undefined, version: number, settled: boolean): number {
    if (settled) return 0;
    if ((previous?.extractionVersion ?? 0) >= version) return 0;
    const held = previous?.extractionAttempts;
    // A newer capability has already tried here and given up. Re-reading the same representation with an
    // older parser cannot learn anything the newer one did not, so a rolled-back deployment gets nothing.
    //
    // This closes the hole the preservation fix opened: keeping N's marker meant M counted as having
    // spent nothing and was granted a full budget, while `countExtractionAttempt` refused to charge M
    // because N's marker outranked it -- three validator-free requests every run, for ever, exactly the
    // unbounded case the whole mechanism exists to prevent (Codex, #68).
    if (held !== undefined && held.version > version) return 0;
    const spent = held?.version === version ? held.tries : 0;
    return Math.max(0, MAX_EXTRACTION_ATTEMPTS - spent);
}

/**
 * Marks unconditional reads as spent against `version`, whatever the run goes on to make of them.
 *
 * `requests` rather than one, because a single `smartFetch` can issue several: a transport error or a
 * 5xx is retried, and under `unconditional` each retry is also validator-free. Charging one per call
 * made the budget three times looser than it reads (Codex, #68).
 */
export function countExtractionAttempt<T extends SourceFetchState>(state: T, previous: SourceFetchState | undefined, version: number, requests = 1): T {
    const held = previous?.extractionAttempts;
    // A newer version's exhausted budget outranks this charge. Overwriting it (Codex, #68) let a
    // rolled-back adapter at version M replace N's counter, and M succeeding then cleared it -- so
    // redeploying N found a full budget and repeated a read it had already given up on.
    if (held !== undefined && held.version > version) return state;
    const spent = held?.version === version ? held.tries : 0;
    return { ...state, extractionAttempts: { version, tries: spent + Math.max(1, requests) } };
}

/**
 * Marks `version` as having read this source in full, and releases the attempt budget.
 *
 * Never lowers the mark. Rolling back to an adapter declaring an older version would otherwise overwrite
 * a newer one on the next changed response, and redeploying would then repeat a capability read that had
 * already happened — a per-version bound that rollback cycles could walk straight through (Codex, #68).
 */
export function recordExtraction<T extends SourceFetchState>(state: T, previous: SourceFetchState | undefined, version: number): T {
    const next = { ...state, extractionVersion: Math.max(previous?.extractionVersion ?? 0, version) };
    // Only the budget this success actually settles. A rolled-back deployment succeeding at version M
    // must not clear the attempts a newer version N already spent, or redeploying N would find a fresh
    // budget and repeat a read it had already given up on (Codex, #68).
    const spentOn = next.extractionAttempts?.version;
    if (spentOn === undefined || spentOn <= version) delete next.extractionAttempts;
    return next;
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
    /**
     * Send the request without validators, so the server answers with a body rather than a 304.
     *
     * For when the caller needs to read the representation again even though it has not changed — see
     * `SourceFetchState.extractionVersion`. The outcome is still reported honestly: identical content is
     * still `unchanged`, it simply arrives with the body attached this time.
     */
    unconditional?: boolean;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
    return status === 0 || status >= 500;
}

export interface SmartFetchResult {
    outcome: "usable" | "unchanged" | "unusable";
    /**
     * HTTP requests this call actually issued, retries included.
     *
     * One `smartFetch` is not one request: a transport error or a 5xx is retried, and with
     * `unconditional` every one of those retries also goes out without validators. A caller spending a
     * per-request budget has to charge what was spent, not what it asked for (Codex, #68).
     */
    requests: number;
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
    } else if (expect.kind === "text") {
        text = normalizeWhitespace(body);
    } else {
        // JSON/XML: whitespace inside values is significant, so the raw body is the text (and the hash input).
        text = body;
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
        requests,
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
            requests,
            state: {
                // Validators belong to the representation that produced this document. A 200 that
                // omits them, or a browser render (no HTTP validators), clears them so a later 304
                // can never be matched against a different representation's hash.
                etag: headers["etag"],
                lastModified: headers["last-modified"],
                textHash: document.textHash,
                lastFetchedAt: nowIso,
                lastUsableAt: nowIso,
                lastVerdict: "usable",
                lastMode: document.mode,
                consecutiveFailures: 0,
                // Carried, never set here. This state is rebuilt from scratch rather than spread, so a
                // field smartFetch does not know about is a field it silently drops — and dropping either
                // of these would re-arm the unconditional fetch on every single run.
                extractionVersion: previous.extractionVersion,
                extractionAttempts: previous.extractionAttempts,
                // The caller that computes it overwrites it from this document; carried so no other caller drops it.
                contentFingerprint: previous.contentFingerprint
            }
        };
    };

    // 1. Plain HTTP with conditional headers; bounded retries on transport errors and 5xx.
    const retries = options.retries ?? 2;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    // Withholding the validators is the whole of "unconditional": the request is otherwise identical, and
    // the server answers 200 with a body instead of 304 without one.
    const etag = options.unconditional ? undefined : previous.etag;
    const lastModified = options.unconditional ? undefined : previous.lastModified;
    let response;
    let lastError: string | undefined;
    let requests = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            requests++;
            response = await transport.get({ url, timeoutMs: options.timeoutMs, etag, lastModified });
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
            requests,
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
    // A rendered document has no HTTP validators; the next run probes unconditionally.
    return succeeded(document, rendered.verdict, {});
}
