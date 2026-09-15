/**
 * SearchProvider: the one abstraction discovery uses to ask "which pages might
 * answer this question?". Two scopes:
 *
 *   official  - deterministic, key-free channels restricted to the game's own
 *               domains (sitemaps, seed listing pages). Always tried first.
 *   web       - a general web search engine. Optional, best effort, and never a
 *               source of publishable truth on its own: its results are only
 *               leads that must land on an official domain to be used.
 *
 * Providers never touch Gemini; AI relevance classification, where useful, is
 * applied to candidates afterwards (see relevance.ts).
 */

export type SearchScope = "official" | "web";

export interface SearchQuery {
    /** Free-text query, e.g. "League of Legends patch schedule". */
    text: string;
    /** Restrict to this domain (and its subdomains), e.g. "riotgames.com". */
    site?: string;
    /** Maximum results wanted (providers may return fewer). */
    limit?: number;
}

export interface SearchResult {
    url: string;
    title: string;
    snippet?: string;
    /** 1-based position in the provider's answer. */
    rank: number;
    provider: string;
    /** Sitemap `lastmod`, when the provider knows it. */
    lastmod?: string;
}

export interface SearchProvider {
    readonly name: string;
    readonly scope: SearchScope;
    search(query: SearchQuery): Promise<SearchResult[]>;
}

export type SearchUnavailableCode = "challenge" | "http-error" | "network" | "disabled" | "budget";

/** The provider could not answer at all (as opposed to answering with no results). */
export class SearchUnavailableError extends Error {
    constructor(message: string, public readonly code: SearchUnavailableCode, public readonly provider: string) {
        super(message);
        this.name = "SearchUnavailableError";
    }
}

export function formatQuery(query: SearchQuery): string {
    return query.site ? `site:${query.site} ${query.text}` : query.text;
}

export type WebSearchProviderName = "duckduckgo" | "none";

export interface SearchConfig {
    provider: WebSearchProviderName;
    /** Web queries allowed per run (official channels are not counted). */
    maxQueries: number;
    /** Minimum spacing between web queries. */
    minIntervalMs: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = { provider: "duckduckgo", maxQueries: 6, minIntervalMs: 3000 };

/**
 * SEARCH_PROVIDER=duckduckgo|none, SEARCH_MAX_QUERIES, SEARCH_MIN_INTERVAL_MS.
 * No API key is involved; a keyed engine can be added as another provider.
 */
export function readSearchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
    const raw = (env.SEARCH_PROVIDER ?? DEFAULT_SEARCH_CONFIG.provider).trim().toLowerCase();
    if (raw !== "duckduckgo" && raw !== "none") {
        throw new Error(`Unsupported SEARCH_PROVIDER ${JSON.stringify(env.SEARCH_PROVIDER)}; expected duckduckgo or none`);
    }
    const maxQueries = env.SEARCH_MAX_QUERIES ? Number(env.SEARCH_MAX_QUERIES) : DEFAULT_SEARCH_CONFIG.maxQueries;
    const minIntervalMs = env.SEARCH_MIN_INTERVAL_MS ? Number(env.SEARCH_MIN_INTERVAL_MS) : DEFAULT_SEARCH_CONFIG.minIntervalMs;
    if (!Number.isInteger(maxQueries) || maxQueries < 0) throw new Error(`SEARCH_MAX_QUERIES must be a non-negative integer`);
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error(`SEARCH_MIN_INTERVAL_MS must be a non-negative number`);
    return { provider: raw, maxQueries, minIntervalMs };
}

export interface MockSearchScript {
    /** Keyed by the formatted query ("site:x.com text" or "text"); a string value is thrown as SearchUnavailableError(code). */
    [query: string]: SearchResult[] | SearchUnavailableCode;
}

/** Scripted provider for tests: records every query it receives. */
export class MockSearchProvider implements SearchProvider {
    readonly queries: SearchQuery[] = [];

    constructor(readonly name: string, readonly scope: SearchScope, private readonly script: MockSearchScript) { }

    async search(query: SearchQuery): Promise<SearchResult[]> {
        this.queries.push(query);
        const entry = this.script[formatQuery(query)];
        if (entry === undefined) return [];
        if (typeof entry === "string") throw new SearchUnavailableError(`${this.name} unavailable (${entry})`, entry, this.name);
        return entry.slice(0, query.limit ?? entry.length).map((r, i) => ({ ...r, rank: i + 1, provider: this.name }));
    }
}
