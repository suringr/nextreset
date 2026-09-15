/**
 * Official-domain search through configured seed pages (listings, hubs).
 *
 * A seed is an official page known to link to the documents a topic needs
 * (for example a "patch notes" listing). Seeds are fetched once per run through
 * the smart fetch layer (browser render allowed, since listings are often
 * client-rendered), their links are extracted, and a query is answered by
 * matching its terms against link text and URL words. The seed page itself is
 * a result too: a listing can be the document to read.
 */
import { SmartFetchResult, smartFetch } from "../fetch/smart-fetch";
import { Transport, defaultTransport } from "../fetch/transport";
import { PageLink, extractLinks, officialLinks } from "./links";
import { SearchProvider, SearchQuery, SearchResult } from "./search-provider";
import { matchedTerms, significantTerms, tokenize } from "./terms";
import { canonicalUrl, hostOf, isEnglishLocale, localeOf, normalizeDomain, slugTokens } from "./urls";

export interface SeedSearchOptions {
    seeds: string[];
    officialDomains: string[];
    transport?: Transport;
    allowRender?: boolean;
    timeoutMs?: number;
    now?: Date;
    /** Minimum visible words for a seed to count as usable (default 30). */
    minWords?: number;
}

export interface SeedFetchLog {
    seed: string;
    outcome: SmartFetchResult["outcome"];
    mode?: "http" | "browser";
    status?: number;
    reason?: string;
    links: number;
}

interface LoadedSeed {
    url: string;
    finalUrl: string;
    title: string;
    links: PageLink[];
}

export class SeedPageSearch implements SearchProvider {
    readonly name = "seed";
    readonly scope = "official" as const;
    readonly fetches: SeedFetchLog[] = [];
    private readonly cache = new Map<string, Promise<LoadedSeed | undefined>>();
    private readonly seeds: string[];
    private readonly officialDomains: string[];
    private readonly transport: Transport;
    private readonly allowRender: boolean;
    private readonly timeoutMs?: number;
    private readonly now?: Date;
    private readonly minWords: number;

    constructor(options: SeedSearchOptions) {
        this.seeds = options.seeds.map(s => canonicalUrl(s)).filter((s): s is string => s !== undefined);
        this.officialDomains = options.officialDomains.map(normalizeDomain);
        this.transport = options.transport ?? defaultTransport();
        this.allowRender = options.allowRender ?? true;
        this.timeoutMs = options.timeoutMs;
        this.now = options.now;
        this.minWords = options.minWords ?? 30;
    }

    private load(seed: string): Promise<LoadedSeed | undefined> {
        let pending = this.cache.get(seed);
        if (!pending) {
            pending = this.fetchSeed(seed);
            this.cache.set(seed, pending);
        }
        return pending;
    }

    private async fetchSeed(seed: string): Promise<LoadedSeed | undefined> {
        const fetched = await smartFetch(seed, {
            expect: { kind: "html", minWords: this.minWords, allowDomains: this.officialDomains },
            allowRender: this.allowRender,
            transport: this.transport,
            label: `seed-${hostOf(seed)}`,
            timeoutMs: this.timeoutMs,
            now: this.now
        });
        if (fetched.outcome === "unusable" || !fetched.document) {
            this.fetches.push({ seed, outcome: fetched.outcome, reason: fetched.error ?? fetched.verdict?.reason ?? "fetch failed", links: 0 });
            return undefined;
        }
        const doc = fetched.document;
        const links = officialLinks(extractLinks(doc.body, doc.finalUrl), this.officialDomains)
            .filter(link => isEnglishLocale(localeOf(link.url)));
        this.fetches.push({ seed, outcome: fetched.outcome, mode: doc.mode, status: doc.status, links: links.length });
        return { url: seed, finalUrl: canonicalUrl(doc.finalUrl) ?? seed, title: doc.title, links };
    }

    async search(query: SearchQuery): Promise<SearchResult[]> {
        const site = query.site ? normalizeDomain(query.site) : undefined;
        const seeds = site ? this.seeds.filter(s => { const h = hostOf(s); return h === site || h.endsWith(`.${site}`); }) : this.seeds;
        const terms = significantTerms(query.text);
        if (seeds.length === 0 || terms.length === 0) return [];
        const needed = Math.max(1, Math.ceil(terms.length / 2));

        const scored = new Map<string, { url: string; title: string; matched: number; viaSeed: string }>();
        const consider = (url: string, title: string, tokens: string[], viaSeed: string) => {
            const matched = matchedTerms(terms, tokens).length;
            if (matched < needed) return;
            const existing = scored.get(url);
            if (!existing || existing.matched < matched) scored.set(url, { url, title, matched, viaSeed });
        };

        for (const seed of seeds) {
            const loaded = await this.load(seed);
            if (!loaded) continue;
            consider(loaded.finalUrl, loaded.title, [...tokenize(loaded.title), ...slugTokens(loaded.finalUrl)], seed);
            for (const link of loaded.links) {
                consider(link.url, link.text, [...tokenize(link.text), ...slugTokens(link.url)], seed);
            }
        }

        return [...scored.values()]
            .sort((a, b) => b.matched - a.matched || a.url.localeCompare(b.url))
            .slice(0, query.limit ?? 10)
            .map((s, i) => ({ url: s.url, title: s.title, snippet: `seed ${s.viaSeed}: ${s.matched}/${terms.length} query terms`, rank: i + 1, provider: this.name }));
    }
}
