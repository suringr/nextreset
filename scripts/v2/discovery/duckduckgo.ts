/**
 * Web search through DuckDuckGo's HTML endpoint (no API key).
 *
 * Best effort only: the endpoint answers a bot challenge (HTTP 202, "complete
 * the following challenge") after a few requests from one address. That is a
 * clean failure here, never something to work around: the provider disables
 * itself for the rest of the run and discovery continues with the official
 * channels. Queries are spaced and capped per run.
 */
import * as cheerio from "cheerio";
import { Transport, defaultTransport } from "../fetch/transport";
import { SearchProvider, SearchQuery, SearchResult, SearchUnavailableError, formatQuery } from "./search-provider";
import { canonicalUrl } from "./urls";

export const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";

const CHALLENGE_MARKERS = ["complete the following challenge", "bots use duckduckgo too", "anomaly-modal", "select all squares containing"];

export interface DuckDuckGoOptions {
    transport?: Transport;
    /** Web queries allowed per provider instance (one instance per run). */
    maxQueries?: number;
    minIntervalMs?: number;
    timeoutMs?: number;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/** Resolves a result link: DuckDuckGo wraps targets as //duckduckgo.com/l/?uddg=<encoded url>. */
export function resolveResultLink(href: string): string | undefined {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    let u: URL;
    try {
        u = new URL(absolute, DUCKDUCKGO_ENDPOINT);
    } catch {
        return undefined;
    }
    const wrapped = u.searchParams.get("uddg");
    if (wrapped) return canonicalUrl(wrapped);
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) return undefined;
    return canonicalUrl(u.toString());
}

export function parseDuckDuckGoResults(html: string): { results: SearchResult[]; challenge: boolean } {
    const lower = html.toLowerCase();
    const challenge = CHALLENGE_MARKERS.some(m => lower.includes(m));
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    $(".result").each((_, el) => {
        const node = $(el);
        if (node.hasClass("result--ad") || /sponsored/i.test(node.attr("class") ?? "")) return;
        const anchor = node.find("a.result__a").first();
        const href = anchor.attr("href");
        if (!href) return;
        const url = resolveResultLink(href);
        if (!url || seen.has(url)) return;
        seen.add(url);
        const title = anchor.text().replace(/\s+/g, " ").trim();
        const snippet = node.find(".result__snippet").first().text().replace(/\s+/g, " ").trim();
        results.push({ url, title, snippet: snippet || undefined, rank: results.length + 1, provider: "duckduckgo" });
    });
    return { results, challenge };
}

export class DuckDuckGoSearch implements SearchProvider {
    readonly name = "duckduckgo";
    readonly scope = "web" as const;
    /** Queries actually sent this run. */
    queriesRun = 0;
    private disabledReason?: string;
    private lastRequestAt = 0;
    private readonly transport: Transport;
    private readonly maxQueries: number;
    private readonly minIntervalMs: number;
    private readonly timeoutMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;

    constructor(options: DuckDuckGoOptions = {}) {
        this.transport = options.transport ?? defaultTransport();
        this.maxQueries = options.maxQueries ?? 6;
        this.minIntervalMs = options.minIntervalMs ?? 3000;
        this.timeoutMs = options.timeoutMs ?? 20000;
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.now = options.now ?? (() => Date.now());
    }

    get disabled(): string | undefined {
        return this.disabledReason;
    }

    async search(query: SearchQuery): Promise<SearchResult[]> {
        if (this.disabledReason) throw new SearchUnavailableError(this.disabledReason, "disabled", this.name);
        if (this.queriesRun >= this.maxQueries) {
            throw new SearchUnavailableError(`web search budget of ${this.maxQueries} queries per run is used up`, "budget", this.name);
        }
        const wait = this.lastRequestAt + this.minIntervalMs - this.now();
        if (wait > 0) await this.sleep(wait);

        const url = `${DUCKDUCKGO_ENDPOINT}?q=${encodeURIComponent(formatQuery(query))}`;
        this.queriesRun++;
        this.lastRequestAt = this.now();
        let response;
        try {
            response = await this.transport.get({ url, timeoutMs: this.timeoutMs, headers: { accept: "text/html" } });
        } catch (error) {
            throw new SearchUnavailableError(`DuckDuckGo request failed: ${error instanceof Error ? error.message : String(error)}`, "network", this.name);
        }

        const parsed = parseDuckDuckGoResults(response.body);
        if (response.status === 202 || parsed.challenge) {
            this.disabledReason = "DuckDuckGo answered with a bot challenge; web search is off for the rest of this run";
            throw new SearchUnavailableError(this.disabledReason, "challenge", this.name);
        }
        if (response.status >= 400 || response.status === 0) {
            throw new SearchUnavailableError(`DuckDuckGo answered HTTP ${response.status}`, "http-error", this.name);
        }
        return parsed.results.slice(0, query.limit ?? 10);
    }
}
