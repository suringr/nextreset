/**
 * Candidates: search results turned into ranked, de-duplicated, tiered URLs.
 *
 * Tier is decided by the host alone: "official" when it is one of the game's
 * official domains (or a subdomain), "secondary" otherwise. Only official
 * candidates are publishable; a secondary page can lead to an official one
 * (links.ts) but never becomes evidence itself.
 */
import { SearchResult } from "./search-provider";
import { matchedTerms, significantTerms, tokenize } from "./terms";
import { canonicalUrl, contentUrlProblem, dedupeKey, isEnglishLocale, isOfficialUrl, localeAgnosticKey, localeOf, slugTokens } from "./urls";

export type SourceTier = "official" | "secondary";

/** How a candidate was found; earlier entries are trusted more when duplicates merge. */
export const VIA_ORDER = ["config", "learned", "sitemap", "seed", "secondary-link", "web"] as const;
export type DiscoveryVia = typeof VIA_ORDER[number];

export interface Candidate {
    url: string;
    title?: string;
    snippet?: string;
    tier: SourceTier;
    via: DiscoveryVia;
    provider: string;
    query?: string;
    /** Deterministic relevance score; higher is better. */
    score: number;
    /** Why the score is what it is (for reports). */
    reasons: string[];
    lastmod?: string;
    locale?: string;
    /** True only for official-tier candidates. */
    publishable: boolean;
}

export interface RejectedCandidate {
    url: string;
    reason: string;
}

export function candidateFrom(result: SearchResult, via: DiscoveryVia, query: string | undefined, officialDomains: string[]): Candidate | undefined {
    const url = canonicalUrl(result.url);
    if (!url) return undefined;
    const tier: SourceTier = isOfficialUrl(url, officialDomains) ? "official" : "secondary";
    return {
        url,
        title: result.title || undefined,
        snippet: result.snippet,
        tier,
        via,
        provider: result.provider,
        query,
        score: 0,
        reasons: [],
        lastmod: result.lastmod,
        locale: localeOf(url),
        publishable: tier === "official"
    };
}

function viaRank(via: DiscoveryVia): number {
    return VIA_ORDER.indexOf(via);
}

function localePreference(locale: string | undefined): number {
    if (locale === undefined) return 1;
    if (locale === "en-us") return 0;
    if (locale.startsWith("en")) return 2;
    return 3;
}

function merge(a: Candidate, b: Candidate): Candidate {
    const [primary, other] = viaRank(a.via) <= viaRank(b.via) ? [a, b] : [b, a];
    return {
        ...primary,
        title: primary.title ?? other.title,
        snippet: primary.snippet ?? other.snippet,
        lastmod: primary.lastmod ?? other.lastmod,
        query: primary.query ?? other.query,
        reasons: [...primary.reasons, ...other.reasons]
    };
}

/**
 * Removes duplicates (scheme/www/tracking spellings, locale variants), keeps
 * English variants, drops non-content URLs. Order of first appearance is kept
 * for equal candidates so ranking stays deterministic.
 */
export function normalizeCandidates(candidates: Candidate[]): { kept: Candidate[]; rejected: RejectedCandidate[] } {
    const rejected: RejectedCandidate[] = [];
    const byKey = new Map<string, Candidate>();
    const order: string[] = [];

    for (const candidate of candidates) {
        const problem = contentUrlProblem(candidate.url);
        if (problem) {
            rejected.push({ url: candidate.url, reason: problem });
            continue;
        }
        const key = dedupeKey(candidate.url);
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, candidate);
            order.push(key);
        } else {
            // Prefer https when the same page appears with both schemes.
            const merged = merge(existing, candidate);
            merged.url = existing.url.startsWith("https:") || !candidate.url.startsWith("https:") ? existing.url : candidate.url;
            byKey.set(key, merged);
        }
    }

    // Collapse locale variants of one page: keep the best English variant.
    const byPage = new Map<string, Candidate[]>();
    for (const key of order) {
        const candidate = byKey.get(key)!;
        const pageKey = localeAgnosticKey(candidate.url);
        const list = byPage.get(pageKey) ?? [];
        list.push(candidate);
        byPage.set(pageKey, list);
    }
    const kept: Candidate[] = [];
    for (const variants of byPage.values()) {
        const sorted = [...variants].sort((a, b) => localePreference(a.locale) - localePreference(b.locale));
        const best = sorted[0];
        if (!isEnglishLocale(best.locale)) {
            for (const v of variants) rejected.push({ url: v.url, reason: `non-English locale ${v.locale}` });
            continue;
        }
        let winner = best;
        for (const v of sorted.slice(1)) {
            if (isEnglishLocale(v.locale)) winner = merge(winner, v);
            else rejected.push({ url: v.url, reason: `locale variant of ${best.url}` });
        }
        winner.url = best.url;
        winner.locale = best.locale;
        kept.push(winner);
    }
    return { kept, rejected };
}

export interface ScoringContext {
    /** Terms of the query that found the candidate (or of the topic when unknown). */
    terms: string[];
    /** Words the topic prefers in a title/URL (from Topic.discovery.terms), e.g. ["schedule", "patch notes"]. */
    preferred: string[];
}

/** Adds the deterministic score and its explanation. Pure: returns a new candidate. */
export function scoreCandidate(candidate: Candidate, ctx: ScoringContext): Candidate {
    const reasons: string[] = [];
    let score = 0;
    if (candidate.tier === "official") {
        score += 3;
        reasons.push("official domain +3");
    }
    const haystack = [...tokenize(candidate.title ?? ""), ...tokenize(candidate.snippet ?? ""), ...slugTokens(candidate.url)];
    const terms = candidate.query ? significantTerms(candidate.query) : ctx.terms;
    const matched = matchedTerms(terms, haystack);
    if (terms.length > 0) {
        score += matched.length;
        reasons.push(`${matched.length}/${terms.length} query terms +${matched.length}`);
        if (matched.length === terms.length) {
            score += 2;
            reasons.push("all query terms +2");
        }
    }
    const titleAndSlug = [...tokenize(candidate.title ?? ""), ...slugTokens(candidate.url)];
    for (const phrase of ctx.preferred) {
        const words = significantTerms(phrase);
        if (words.length > 0 && matchedTerms(words, titleAndSlug).length === words.length) {
            score += 2;
            reasons.push(`preferred "${phrase}" in title/URL +2`);
        }
    }
    if (candidate.via === "sitemap" || candidate.via === "seed" || candidate.via === "learned" || candidate.via === "config") {
        score += 1;
        reasons.push(`found via ${candidate.via} +1`);
    }
    return { ...candidate, score, reasons: [...candidate.reasons, ...reasons] };
}

/** Deterministic order: score, then official first, then how it was found, then URL. */
export function rankCandidates(candidates: Candidate[]): Candidate[] {
    return [...candidates].sort((a, b) =>
        b.score - a.score ||
        (a.tier === b.tier ? 0 : a.tier === "official" ? -1 : 1) ||
        viaRank(a.via) - viaRank(b.via) ||
        a.url.localeCompare(b.url)
    );
}

/** Official-tier candidates only: the ones that may become evidence. */
export function publishableCandidates(candidates: Candidate[]): Candidate[] {
    return candidates.filter(c => c.publishable && c.tier === "official");
}
