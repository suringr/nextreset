/**
 * Transport: plain HTTP with conditional requests, and budgeted browser rendering.
 *
 * Kept separate from smart-fetch so tests can inject a fake transport and never
 * touch the network or Playwright. The browser path reuses the V1 fetch layer's
 * shared browser budget and is loaded lazily.
 */
import * as fs from "fs";
import * as path from "path";
import { Verdict } from "./content-validation";

export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Where failed renders leave a screenshot + HTML. Never under public/; CI uploads it as an artifact. */
export const DEBUG_CAPTURE_DIR = path.join(process.cwd(), "build", "debug");

export interface HttpRequest {
    url: string;
    timeoutMs?: number;
    headers?: Record<string, string>;
    /** Sent as If-None-Match / If-Modified-Since when present. */
    etag?: string;
    lastModified?: string;
}

export interface HttpResponse {
    status: number;
    finalUrl: string;
    headers: Record<string, string>;
    body: string;
    /** HTTP 304: the server confirmed the cached copy is still current. */
    notModified: boolean;
    elapsedMs: number;
}

export interface RenderRequest {
    url: string;
    timeoutMs?: number;
    /** Extra settle time after load for client-side rendering. */
    settleMs?: number;
    /** Keep re-validating after the settle time until this much time has passed since load (default 12000). */
    maxWaitMs?: number;
    /** Used for debug capture file names. */
    label?: string;
    /** Runs inside the browser session; an unusable verdict triggers a debug capture. */
    validate: (html: string, status: number, finalUrl: string) => Verdict;
}

export interface RenderResponse {
    status: number;
    finalUrl: string;
    html: string;
    verdict: Verdict;
    elapsedMs: number;
    capture?: { html: string; screenshot: string };
}

export interface Transport {
    get(req: HttpRequest): Promise<HttpResponse>;
    /** Absent when rendering is not available (tests, budget exhausted). */
    render?(req: RenderRequest): Promise<RenderResponse>;
    /** Remaining browser launches for this run, when known. */
    renderBudget?(): number;
}

export async function httpGet(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 15000);
    const started = Date.now();
    try {
        const headers: Record<string, string> = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            ...(req.headers ?? {})
        };
        if (req.etag) headers["If-None-Match"] = req.etag;
        if (req.lastModified) headers["If-Modified-Since"] = req.lastModified;

        const response = await fetch(req.url, { headers, signal: controller.signal, redirect: "follow" });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
        const notModified = response.status === 304;
        const body = notModified ? "" : await response.text();
        return {
            status: response.status,
            finalUrl: response.url || req.url,
            headers: responseHeaders,
            body,
            notModified,
            elapsedMs: Date.now() - started
        };
    } finally {
        clearTimeout(timer);
    }
}

function safeFileStem(label: string): string {
    return label.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "capture";
}

/** Renders with the shared Playwright budget from the V1 fetch layer. */
export async function renderWithBrowser(req: RenderRequest): Promise<RenderResponse> {
    const { withBrowserPage, sleep } = await import("../../lib/fetch-layer");
    const started = Date.now();
    return withBrowserPage(async (page) => {
        const response = await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: req.timeoutMs ?? 30000 });
        const status = response?.status() ?? 0;
        const settleMs = req.settleMs ?? 2500;
        const maxWaitMs = Math.max(settleMs, req.maxWaitMs ?? 12000);
        await sleep(settleMs);
        let waited = settleMs;
        let html = await page.content();
        let finalUrl = page.url();
        let verdict = req.validate(html, status, finalUrl);
        // Client-rendered pages (the Riot support site takes ~8s) fill in after load: keep checking, bounded.
        while (!verdict.usable && verdict.renderMayHelp && waited < maxWaitMs) {
            const step = Math.min(1500, maxWaitMs - waited);
            await sleep(step);
            waited += step;
            html = await page.content();
            finalUrl = page.url();
            verdict = req.validate(html, status, finalUrl);
        }

        let capture: RenderResponse["capture"];
        if (!verdict.usable) {
            try {
                fs.mkdirSync(DEBUG_CAPTURE_DIR, { recursive: true });
                const stem = `${safeFileStem(req.label ?? "render")}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
                const htmlPath = path.join(DEBUG_CAPTURE_DIR, `${stem}.html`);
                const pngPath = path.join(DEBUG_CAPTURE_DIR, `${stem}.png`);
                fs.writeFileSync(htmlPath, html.slice(0, 50 * 1024), "utf8");
                await page.screenshot({ path: pngPath, fullPage: true });
                capture = { html: htmlPath, screenshot: pngPath };
            } catch {
                // Capture is best-effort diagnostics; never fail the fetch over it.
            }
        }

        return { status, finalUrl, html, verdict, elapsedMs: Date.now() - started, capture };
    });
}

export function defaultTransport(): Transport {
    return {
        get: httpGet,
        render: renderWithBrowser,
        renderBudget: () => {
            // Lazy to avoid loading Playwright in tests that never render.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const layer = require("../../lib/fetch-layer") as typeof import("../../lib/fetch-layer");
            return layer.getBrowserBudgetRemaining();
        }
    };
}
