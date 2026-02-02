import { chromium, Browser, Page } from 'playwright';
import { FailureType } from '../types';

/**
 * Global budget tracker for browser usage
 */
class BrowserBudget {
    private count = 0;
    private readonly MAX = 3;

    canUse(): boolean {
        return this.count < this.MAX;
    }

    use(): void {
        this.count++;
    }

    getRemaining(): number {
        return this.MAX - this.count;
    }
}

const budget = new BrowserBudget();

export interface FetchOptions {
    timeout?: number;
    retries?: number;
    useBrowserOnBlocked?: boolean;
    headers?: Record<string, string>;
    providerId?: string;
}

export interface FetchResult {
    ok: boolean;
    status: number;
    text: string;
    mode: "http" | "browser";
    url?: string;
    error?: string;
    failureType?: FailureType;
}

const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
};

/**
 * Sleep helper
 */
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Fetch HTML content using native fetch or Playwright
 */
export async function fetchHtml(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const {
        timeout = 10000,
        retries = 2,
        useBrowserOnBlocked = false,
        headers = {},
        providerId
    } = options;

    const mergedHeaders = { ...DEFAULT_HEADERS, ...headers };

    // Try HTTP first
    let lastError: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
                headers: mergedHeaders,
                signal: controller.signal
            });

            clearTimeout(id);

            if (response.ok) {
                const text = await response.text();
                return {
                    ok: true,
                    status: response.status,
                    text,
                    mode: "http",
                    url: response.url
                };
            }

            // If blocked and browser fallback enabled
            if ((response.status === 403 || response.status === 429) && useBrowserOnBlocked) {
                if (budget.canUse()) {
                    console.log(`[Fetch] ${url} blocked (${response.status}). Retrying via browser...`);
                    budget.use();
                    return await fetchWithBrowser(url, timeout, providerId);
                } else {
                    console.warn(`[Fetch] ${url} blocked, but browser budget exhausted.`);
                    return {
                        ok: false,
                        status: response.status,
                        text: "",
                        mode: "http",
                        error: "Blocked and browser budget exhausted",
                        failureType: FailureType.Blocked
                    };
                }
            }

            // Other errors - classification
            const failureType = classifyStatus(response.status);
            if (attempt === retries) {
                return {
                    ok: false,
                    status: response.status,
                    text: "",
                    mode: "http",
                    error: `HTTP ${response.status}`,
                    failureType
                };
            }

        } catch (err: any) {
            lastError = err;
            if (attempt === retries) break;
            const backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 5000);
            await sleep(backoff);
        }
    }

    return {
        ok: false,
        status: 0,
        text: "",
        mode: "http",
        error: lastError?.message || "Unknown error",
        failureType: lastError?.name === 'AbortError' ? FailureType.Unavailable : FailureType.Unavailable
    };
}

/**
 * Get remaining browser budget
 */
export function getBrowserBudgetRemaining(): number {
    return budget.getRemaining();
}

/**
 * Execute a callback within a single browser session (Page).
 * Consumes budget only once on successful launch.
 */
export async function withBrowserPage<T>(callback: (page: Page) => Promise<T>): Promise<T> {
    if (!budget.canUse()) {
        throw new Error("Browser budget exhausted");
    }

    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: DEFAULT_HEADERS["User-Agent"]
        });
        page = await context.newPage();

        // Increment budget ONLY after successful launch
        budget.use();

        return await callback(page);
    } finally {
        if (page) await page.close();
        if (browser) await browser.close();
    }
}

/**
 * Fetch using Playwright
 */
async function fetchWithBrowser(url: string, timeout: number, providerId?: string): Promise<FetchResult> {
    const logPrefix = `[BrowserFetch][${providerId || 'Unknown'}]`;
    console.log(`${logPrefix} Starting fallback for ${url}`);
    console.log(`${logPrefix} Time: ${new Date().toISOString()}`);
    console.log(`${logPrefix} Headless: true`);
    console.log(`${logPrefix} Node: ${process.version}, Platform: ${process.platform}, Arch: ${process.arch}`);

    let browser: Browser | null = null;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: DEFAULT_HEADERS["User-Agent"]
        });
        const page = await context.newPage();

        let response = null;
        try {
            response = await page.goto(url, {
                waitUntil: 'load',
                timeout: Math.max(timeout, 30000)
            });
        } catch (e) {
            console.error(`${logPrefix} Navigation failed: ${e}`);
            throw e;
        }

        const finalUrl = page.url();
        const status = response?.status() || 0;

        // Safe headers
        const headers = response?.headers() || {};
        const safeHeaders = ['server', 'content-type', 'cf-ray', 'cf-cache-status', 'location'];
        const loggedHeaders = safeHeaders.reduce((acc, h) => {
            if (headers[h]) acc[h] = headers[h];
            return acc;
        }, {} as Record<string, string>);

        console.log(`${logPrefix} Navigation Complete. Status: ${status}`);
        console.log(`${logPrefix} Final URL: ${finalUrl}`);
        console.log(`${logPrefix} Headers: ${JSON.stringify(loggedHeaders)}`);

        // Failure handling
        const isOk = status >= 200 && status < 300;
        if (!isOk || status === 403) {
            console.warn(`${logPrefix} Request failed with status ${status}. Capturing debug info...`);

            try {
                const title = await page.title();
                console.log(`${logPrefix} Page Title: ${title}`);
            } catch (e) { }

            try {
                const content = await page.content();
                console.log(`${logPrefix} Content Snippet: ${content.slice(0, 500).replace(/\n/g, ' ')}`);

                // Debug Artifacts
                const debugDir = path.join(process.cwd(), 'public', 'data', '_debug');
                try {
                    await fs.mkdir(debugDir, { recursive: true });
                } catch { }

                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const baseFilename = `${providerId || 'unknown'}.${timestamp}`;

                try {
                    await page.screenshot({ path: path.join(debugDir, `${baseFilename}.png`), fullPage: true });
                    console.log(`${logPrefix} Saved screenshot to ${baseFilename}.png`);
                } catch (e) { console.error(`${logPrefix} Failed screenshot: ${e}`); }

                try {
                    await fs.writeFile(path.join(debugDir, `${baseFilename}.html`), content.slice(0, 50 * 1024));
                    console.log(`${logPrefix} Saved HTML to ${baseFilename}.html`);
                } catch (e) { console.error(`${logPrefix} Failed save HTML: ${e}`); }

            } catch (e) {
                console.error(`${logPrefix} Error capturing debug content: ${e}`);
            }
        }

        // Small wait for SPAs to render
        await sleep(2000);

        const text = await page.content();

        await browser.close();

        return {
            ok: isOk,
            status,
            text,
            mode: "browser",
            url: finalUrl
        };
    } catch (err: any) {
        if (browser) await browser.close();
        console.error(`${logPrefix} Detailed Error: ${err.stack || err.message}`);
        return {
            ok: false,
            status: 0,
            text: "",
            mode: "browser",
            error: err.message,
            failureType: FailureType.Blocked
        };
    }
}

function classifyStatus(status: number): FailureType {
    if (status === 403 || status === 429) return FailureType.Blocked;
    if (status >= 500 || status === 0) return FailureType.Unavailable;
    return FailureType.Unavailable; // Default to unavailable
}
