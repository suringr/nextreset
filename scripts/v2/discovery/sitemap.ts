/**
 * Official-domain search through XML sitemaps (no API key, deterministic).
 *
 *   robots.txt  -> Sitemap: lines (fallback: /sitemap.xml, /sitemap_index.xml)
 *   sitemap index -> child sitemaps for the wanted locale (capped)
 *   urlset      -> <loc> + <lastmod> entries, cached per host for the run
 *
 * A query is answered by matching its terms against the words of each URL's
 * path. Sitemaps go through the smart fetch layer so malformed XML and
 * challenge pages are rejected instead of parsed.
 */
import { XMLParser } from "fast-xml-parser";
import { smartFetch } from "../fetch/smart-fetch";
import { Transport, defaultTransport } from "../fetch/transport";
import { SearchProvider, SearchQuery, SearchResult } from "./search-provider";
import { matchedTerms, significantTerms } from "./terms";
import { canonicalUrl, hostOf, localeOf, normalizeDomain, slugTokens } from "./urls";

/** Upper bound on sitemaps read from one robots.txt, so a host cannot fan a run out indefinitely. */
const MAX_DECLARED_SITEMAPS = 10;

export interface SitemapEntry {
    url: string;
    lastmod?: string;
}

export type ParsedSitemap = { kind: "index"; sitemaps: SitemapEntry[] } | { kind: "urlset"; urls: SitemapEntry[] };

function entriesOf(value: unknown): SitemapEntry[] {
    const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const out: SitemapEntry[] = [];
    for (const item of list) {
        const loc = typeof item === "object" && item !== null ? (item as { loc?: unknown }).loc : undefined;
        const lastmod = typeof item === "object" && item !== null ? (item as { lastmod?: unknown }).lastmod : undefined;
        if (typeof loc !== "string") continue;
        const url = canonicalUrl(loc);
        if (!url) continue;
        out.push({ url, lastmod: typeof lastmod === "string" ? lastmod : typeof lastmod === "number" ? String(lastmod) : undefined });
    }
    return out;
}

/** Parses a sitemap index or urlset; undefined for other XML. */
export function parseSitemap(xml: string): ParsedSitemap | undefined {
    let parsed: any;
    try {
        parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
    } catch {
        return undefined;
    }
    if (parsed?.sitemapindex !== undefined) return { kind: "index", sitemaps: entriesOf(parsed.sitemapindex.sitemap) };
    if (parsed?.urlset !== undefined) return { kind: "urlset", urls: entriesOf(parsed.urlset.url) };
    return undefined;
}

/** Sitemap URLs declared in robots.txt, in order. */
export function sitemapUrlsFromRobots(robotsTxt: string, baseUrl: string): string[] {
    const out: string[] = [];
    for (const line of robotsTxt.split(/\r?\n/)) {
        const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
        if (!m) continue;
        const url = canonicalUrl(m[1], baseUrl);
        if (url && !out.includes(url)) out.push(url);
    }
    return out;
}

export interface SitemapSearchOptions {
    /** Hosts to index, e.g. ["support.riotgames.com"]. */
    hosts: string[];
    transport?: Transport;
    /** Preferred locale for child sitemaps and URLs (default "en-us"). */
    locale?: string;
    /** Child sitemaps fetched per host (default 3). */
    maxChildSitemaps?: number;
    timeoutMs?: number;
    now?: Date;
}

export interface SitemapFetchLog {
    host: string;
    url: string;
    outcome: "usable" | "unusable";
    reason?: string;
    entries: number;
}

export class SitemapSearch implements SearchProvider {
    readonly name = "sitemap";
    readonly scope = "official" as const;
    readonly fetches: SitemapFetchLog[] = [];
    private readonly cache = new Map<string, Promise<SitemapEntry[]>>();
    private readonly transport: Transport;
    private readonly hosts: string[];
    private readonly locale: string;
    private readonly maxChildSitemaps: number;
    private readonly timeoutMs?: number;
    private readonly now?: Date;

    constructor(options: SitemapSearchOptions) {
        this.transport = options.transport ?? defaultTransport();
        this.hosts = options.hosts.map(normalizeDomain).filter(h => h.length > 0);
        this.locale = (options.locale ?? "en-us").toLowerCase();
        this.maxChildSitemaps = options.maxChildSitemaps ?? 3;
        this.timeoutMs = options.timeoutMs;
        this.now = options.now;
    }

    private async fetchXml(host: string, url: string): Promise<ParsedSitemap | undefined> {
        const fetched = await smartFetch(url, {
            expect: { kind: "xml", allowHosts: [host, hostOf(url)] },
            allowRender: false,
            transport: this.transport,
            label: `sitemap-${host}`,
            timeoutMs: this.timeoutMs,
            retries: 1,
            retryDelayMs: 500,
            now: this.now
        });
        if (fetched.outcome === "unusable" || !fetched.document) {
            this.fetches.push({ host, url, outcome: "unusable", reason: fetched.error ?? fetched.verdict?.reason ?? "fetch failed", entries: 0 });
            return undefined;
        }
        const parsed = parseSitemap(fetched.document.body);
        const entries = parsed ? (parsed.kind === "index" ? parsed.sitemaps.length : parsed.urls.length) : 0;
        this.fetches.push({ host, url, outcome: parsed ? "usable" : "unusable", reason: parsed ? undefined : "not a sitemap", entries });
        return parsed;
    }

    /**
     * Sitemaps to read for a host. Sitemaps declared in robots.txt are independent and all of them
     * are read (up to MAX_DECLARED_SITEMAPS); the conventional locations are alternatives, so the
     * first non-empty one is enough.
     */
    private async discoverSitemapUrls(host: string): Promise<{ urls: string[]; declared: boolean }> {
        const base = `https://${host}/`;
        try {
            const robots = await this.transport.get({ url: `${base}robots.txt`, timeoutMs: this.timeoutMs });
            if (robots.status === 200 && robots.body) {
                const declared = sitemapUrlsFromRobots(robots.body, base);
                if (declared.length > 0) return { urls: declared.slice(0, MAX_DECLARED_SITEMAPS), declared: true };
            }
        } catch {
            // robots.txt is optional; fall through to the conventional locations.
        }
        return { urls: [`${base}sitemap.xml`, `${base}sitemap_index.xml`], declared: false };
    }

    private childMatchesLocale(url: string): boolean {
        const locale = localeOf(url);
        if (locale === this.locale) return true;
        if (locale !== undefined) return false;
        const lower = url.toLowerCase();
        return lower.includes(`/${this.locale}/`) || lower.includes(`-${this.locale}.`) || lower.includes(`_${this.locale}.`) || !/[/_-][a-z]{2}-[a-z]{2}[/_.]/.test(lower);
    }

    /** All URL entries known for a host (fetched once per run). */
    entriesFor(host: string): Promise<SitemapEntry[]> {
        const normalized = normalizeDomain(host);
        let pending = this.cache.get(normalized);
        if (!pending) {
            pending = this.loadEntries(normalized);
            this.cache.set(normalized, pending);
        }
        return pending;
    }

    private async loadEntries(host: string): Promise<SitemapEntry[]> {
        const entries: SitemapEntry[] = [];
        const { urls, declared } = await this.discoverSitemapUrls(host);
        for (const sitemapUrl of urls) {
            const parsed = await this.fetchXml(host, sitemapUrl);
            if (!parsed) continue;
            if (parsed.kind === "urlset") {
                entries.push(...parsed.urls);
            } else {
                const children = parsed.sitemaps.filter(s => this.childMatchesLocale(s.url)).slice(0, this.maxChildSitemaps);
                for (const child of children) {
                    const childParsed = await this.fetchXml(host, child.url);
                    if (childParsed?.kind === "urlset") entries.push(...childParsed.urls);
                }
            }
            if (!declared && entries.length > 0) break;
        }
        return entries;
    }

    async search(query: SearchQuery): Promise<SearchResult[]> {
        const site = query.site ? normalizeDomain(query.site) : undefined;
        const hosts = site ? this.hosts.filter(h => h === site || h.endsWith(`.${site}`)) : this.hosts;
        const terms = significantTerms(query.text);
        if (hosts.length === 0 || terms.length === 0) return [];
        const needed = Math.max(1, Math.ceil(terms.length / 2));

        const scored: Array<{ entry: SitemapEntry; matched: number }> = [];
        for (const host of hosts) {
            for (const entry of await this.entriesFor(host)) {
                const locale = localeOf(entry.url);
                if (locale !== undefined && locale !== this.locale && !locale.startsWith("en")) continue;
                const matched = matchedTerms(terms, slugTokens(entry.url)).length;
                if (matched >= needed) scored.push({ entry, matched });
            }
        }
        scored.sort((a, b) => b.matched - a.matched || (b.entry.lastmod ?? "").localeCompare(a.entry.lastmod ?? "") || a.entry.url.localeCompare(b.entry.url));
        return scored.slice(0, query.limit ?? 10).map((s, i) => ({
            url: s.entry.url,
            title: "",
            snippet: `sitemap: ${s.matched}/${terms.length} query terms in the URL`,
            rank: i + 1,
            provider: this.name,
            lastmod: s.entry.lastmod
        }));
    }
}
