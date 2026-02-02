/**
 * Robust HTTP fetch helper with retries and browser-like headers
 */

export interface FetchOptions {
    timeout?: number;
    retries?: number;
    headers?: Record<string, string>;
}

export interface FetchResult {
    ok: boolean;
    status: number;
    text: string;
    error?: string;
}

const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9"
};

/**
 * Sleep for given milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate backoff with jitter
 */
function getBackoff(attempt: number, baseMs: number = 1000): number {
    const exponential = baseMs * Math.pow(2, attempt);
    const jitter = Math.random() * 500;
    return Math.min(exponential + jitter, 10000);
}

/**
 * Fetch with retry, timeout, and browser-like headers
 * Never throws - always returns FetchResult
 */
export async function fetchWithRetry(
    url: string,
    options: FetchOptions = {}
): Promise<FetchResult> {
    const { timeout = 10000, retries = 3, headers = {} } = options;

    const mergedHeaders = { ...DEFAULT_HEADERS, ...headers };

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            // Dynamic import for node-fetch (ESM compatible)
            const fetch = (await import("node-fetch")).default;

            const response = await fetch(url, {
                headers: mergedHeaders,
                signal: controller.signal as any
            });

            clearTimeout(timeoutId);

            const text = await response.text();

            return {
                ok: response.ok,
                status: response.status,
                text
            };
        } catch (err) {
            const isLastAttempt = attempt === retries;
            const errorMessage = err instanceof Error ? err.message : String(err);

            // Check if aborted (timeout)
            if (errorMessage.includes("aborted") || errorMessage.includes("abort")) {
                if (isLastAttempt) {
                    return {
                        ok: false,
                        status: 0,
                        text: "",
                        error: `Timeout after ${timeout}ms`
                    };
                }
            }

            if (isLastAttempt) {
                return {
                    ok: false,
                    status: 0,
                    text: "",
                    error: errorMessage
                };
            }

            // Wait before retry
            const backoff = getBackoff(attempt);
            await sleep(backoff);
        }
    }

    // Should never reach here, but TypeScript needs it
    return {
        ok: false,
        status: 0,
        text: "",
        error: "Unknown error"
    };
}
