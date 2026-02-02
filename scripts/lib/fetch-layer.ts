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

/**
 * Fetch HTML content using native fetch or Playwright
 */
export async function fetchHtml(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const {
        timeout = 10000,
        retries = 2,
        useBrowserOnBlocked = false,
        headers = {}
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
                    return await fetchWithBrowser(url, timeout);
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
async function fetchWithBrowser(url: string, timeout: number): Promise<FetchResult> {
    let browser: Browser | null = null;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: DEFAULT_HEADERS["User-Agent"]
        });
        const page = await context.newPage();

        // Use 'load' and then wait a bit for dynamic content
        const response = await page.goto(url, {
            waitUntil: 'load',
            timeout: Math.max(timeout, 30000)
        });

        // Small wait for SPAs to render
        await sleep(2000);

        const status = response?.status() || 0;
        const text = await page.content();

        await browser.close();

        return {
            ok: status >= 200 && status < 300,
            status,
            text,
            mode: "browser",
            url: page.url()
        };
    } catch (err: any) {
        if (browser) await browser.close();
        return {
            ok: false,
            status: 0,
            text: "",
            mode: "browser",
            error: err.message,
            failureType: FailureType.Blocked // Assume still blocked or unavailable if browser fails
        };
    }
}

function classifyStatus(status: number): FailureType {
    if (status === 403 || status === 429) return FailureType.Blocked;
    if (status >= 500 || status === 0) return FailureType.Unavailable;
    return FailureType.Unavailable; // Default to unavailable
}
