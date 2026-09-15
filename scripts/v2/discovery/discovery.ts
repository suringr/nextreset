/**
 * Web discovery: find the page that answers a topic's open question when the
 * exact URL is not known.
 *
 *   game + topic + current knowledge
 *   -> deterministic query templates (queries.ts)
 *   -> official channels first: sitemaps, seed pages (sitemap.ts, seed.ts)
 *   -> web search only if they found nothing convincing (duckduckgo.ts),
 *      site-restricted queries before open ones
 *   -> secondary results may lead to official links (one hop, links.ts)
 *   -> normalize, dedupe, tier, score, rank (candidates.ts)
 *   -> AI relevance nudge only when the ranking is too close to call (relevance.ts)
 *
 * The result is a ranked list of candidates with an explanation for each; the
 * caller fetches, validates and extracts, then learns the page that worked
 * (learning.ts). Secondary pages are never publishable.
 */
import { AiProvider, AiUsage } from "../ai/provider";
import { DiscoveryVia, Game, GameKnowledge, Topic } from "../domain";
import { smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
import { eventsForTopic } from "../knowledge";
import { selectCurrentEvent } from "../views";
import { Candidate, RejectedCandidate, ScoringContext, candidateFrom, normalizeCandidates, publishableCandidates, rankCandidates, scoreCandidate } from "./candidates";
import { DuckDuckGoSearch } from "./duckduckgo";
import { extractLinks, officialLinks } from "./links";
import { buildQueries } from "./queries";
import { applyRelevance, classifyRelevance, needsAiRelevance } from "./relevance";
import { SearchConfig, SearchProvider, SearchQuery, SearchUnavailableError, formatQuery } from "./search-provider";
import { SeedPageSearch } from "./seed";
import { SitemapSearch } from "./sitemap";
import { significantTerms } from "./terms";
import { normalizeDomain } from "./urls";

export interface DiscoveryLimits {
    /** Web queries per discovery run (official channels are not counted). */
    maxWebQueries: number;
    /** Secondary pages fetched to look for official links. */
    maxSecondaryHops: number;
    /** Score at which an official candidate counts as convincing enough to skip further searching. */
    minOfficialScore: number;
    resultsPerQuery: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = { maxWebQueries: 4, maxSecondaryHops: 2, minOfficialScore: 6, resultsPerQuery: 8 };

export interface DiscoveryOptions {
    game: Game;
    topic: Topic;
    knowledge: GameKnowledge;
    now: Date;
    officialProviders: SearchProvider[];
    webProvider?: SearchProvider;
    /** Used for the secondary-page hop; omit to disable the hop. */
    transport?: Transport;
    ai?: AiProvider;
    limits?: Partial<DiscoveryLimits>;
    /** Label of the latest known event, for {latest}/{next} query placeholders; derived from knowledge when omitted. */
    latestLabel?: string;
}

export interface QueryLog {
    provider: string;
    query: string;
    results: number;
    error?: string;
    elapsedMs: number;
}

export interface DiscoveryResult {
    /** All candidates, best first, secondary ones included (publishable: false). */
    candidates: Candidate[];
    /** Official-tier candidates only, best first. */
    official: Candidate[];
    queries: QueryLog[];
    rejected: RejectedCandidate[];
    searchedWeb: boolean;
    /** Providers that could not answer (challenge, budget, network). */
    unavailable: string[];
    ai?: { used: boolean; verdicts: number; error?: string; usage?: AiUsage };
}

/** Whether known sources already answer the topic's open question, so discovery can be skipped. */
export function shouldDiscover(input: { topic: Topic; knowledge: GameKnowledge; now: Date; knownSources: number; usableKnownSources: number }): { discover: boolean; reason: string } {
    const { topic, knowledge, now } = input;
    if (input.knownSources === 0) return { discover: true, reason: "no known source for this topic" };
    if (input.usableKnownSources === 0) return { discover: true, reason: "no known source was usable" };
    const answeredWhen = topic.discovery?.answeredWhen ?? (topic.kind === "version" || topic.kind === "occurrence" ? "future-scheduled" : "usable-source");
    if (answeredWhen === "usable-source") return { discover: false, reason: "a known source was usable" };
    const current = selectCurrentEvent(eventsForTopic(knowledge, topic.type), now);
    if (current && current.status === "scheduled" && current.at && Date.parse(current.at) > now.getTime()) {
        return { discover: false, reason: `next event already known: ${current.label} at ${current.at}` };
    }
    return { discover: true, reason: "known sources do not answer the open question (no future scheduled event)" };
}

/** Builds the default providers for a game from its discovery configuration and the search config. */
export function createSearchProviders(game: Game, config: SearchConfig, options: { transport?: Transport; now?: Date } = {}): { official: SearchProvider[]; web?: SearchProvider } {
    const discovery = game.discovery;
    const official: SearchProvider[] = [];
    if (discovery?.sitemapHosts && discovery.sitemapHosts.length > 0) {
        official.push(new SitemapSearch({ hosts: discovery.sitemapHosts, transport: options.transport, now: options.now }));
    }
    if (discovery?.seeds && discovery.seeds.length > 0) {
        official.push(new SeedPageSearch({ seeds: discovery.seeds, officialDomains: discovery.officialDomains, transport: options.transport, now: options.now }));
    }
    const web = config.provider === "duckduckgo"
        ? new DuckDuckGoSearch({ transport: options.transport, maxQueries: config.maxQueries, minIntervalMs: config.minIntervalMs })
        : undefined;
    return { official, web };
}

function viaFor(provider: SearchProvider): DiscoveryVia {
    if (provider.name === "sitemap") return "sitemap";
    if (provider.name === "seed") return "seed";
    return "web";
}

export async function discoverSources(options: DiscoveryOptions): Promise<DiscoveryResult> {
    const { game, topic, knowledge, now } = options;
    const limits = { ...DEFAULT_DISCOVERY_LIMITS, ...options.limits };
    const domains = (game.discovery?.officialDomains ?? []).map(normalizeDomain);
    const latestLabel = options.latestLabel ?? selectCurrentEvent(eventsForTopic(knowledge, topic.type), now)?.label;
    const queries = buildQueries({ game, topic, latestLabel });
    const scoring: ScoringContext = {
        terms: significantTerms(queries.open[0]?.text ?? `${game.name} ${topic.type.replace(/-/g, " ")}`),
        preferred: topic.discovery?.terms ?? []
    };

    const raw: Candidate[] = [];
    const log: QueryLog[] = [];
    const unavailable: string[] = [];
    const dead = new Set<string>();

    const run = async (provider: SearchProvider, query: SearchQuery, via: DiscoveryVia): Promise<void> => {
        if (dead.has(provider.name)) return;
        const started = Date.now();
        const text = formatQuery(query);
        try {
            const results = await provider.search({ ...query, limit: limits.resultsPerQuery });
            log.push({ provider: provider.name, query: text, results: results.length, elapsedMs: Date.now() - started });
            for (const result of results) {
                const candidate = candidateFrom(result, via, query.text, domains);
                if (candidate) raw.push(candidate);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.push({ provider: provider.name, query: text, results: 0, error: message, elapsedMs: Date.now() - started });
            if (!unavailable.includes(provider.name)) unavailable.push(provider.name);
            // A challenge, exhausted budget or disabled provider will not recover within this run.
            if (error instanceof SearchUnavailableError && error.code !== "http-error" && error.code !== "network") dead.add(provider.name);
        }
    };

    const rankAll = (): { ranked: Candidate[]; rejected: RejectedCandidate[] } => {
        const { kept, rejected } = normalizeCandidates(raw);
        return { ranked: rankCandidates(kept.map(c => scoreCandidate(c, scoring))), rejected };
    };
    const convincing = (ranked: Candidate[]) => publishableCandidates(ranked).some(c => c.score >= limits.minOfficialScore);

    // 1. Official channels: every query text, providers are domain-restricted by construction.
    const texts = queries.open.map(q => q.text);
    for (const provider of options.officialProviders) {
        for (const text of texts) await run(provider, { text }, viaFor(provider));
    }
    let { ranked, rejected } = rankAll();

    // 2. Web search, only when the official channels found nothing convincing. Per template:
    //    the site-restricted variants first, then the open query, so a small budget still
    //    reaches an open query for the most important template.
    const webOrder: SearchQuery[] = [];
    queries.open.forEach(open => {
        webOrder.push(...queries.official.filter(q => q.text === open.text), open);
    });
    let searchedWeb = false;
    if (!convincing(ranked) && options.webProvider) {
        searchedWeb = true;
        let used = 0;
        for (const query of webOrder) {
            if (used >= limits.maxWebQueries || dead.has(options.webProvider.name)) break;
            await run(options.webProvider, query, "web");
            used++;
            ({ ranked, rejected } = rankAll());
            if (convincing(ranked)) break;
        }

        // 3. Secondary pages may link to the official page: one hop, capped, never publishable themselves.
        if (!convincing(ranked) && options.transport && limits.maxSecondaryHops > 0) {
            const secondary = ranked.filter(c => c.tier === "secondary").slice(0, limits.maxSecondaryHops);
            for (const page of secondary) {
                const fetched = await smartFetch(page.url, { expect: { kind: "html", minWords: 20 }, allowRender: false, transport: options.transport, label: `secondary-hop`, retries: 0, now });
                if (fetched.outcome === "unusable" || !fetched.document) {
                    rejected.push({ url: page.url, reason: `secondary page not usable: ${fetched.error ?? fetched.verdict?.reason ?? "fetch failed"}` });
                    continue;
                }
                const links = officialLinks(extractLinks(fetched.document.body, fetched.document.finalUrl), domains);
                for (const link of links) {
                    raw.push({ url: link.url, title: link.text || undefined, tier: "official", via: "secondary-link", provider: page.provider, query: page.query, score: 0, reasons: [`linked from ${page.url}`], publishable: true });
                }
            }
            ({ ranked, rejected } = rankAll());
        }
    }

    // 4. AI relevance only where the deterministic ranking is too close to call.
    let ai: DiscoveryResult["ai"];
    if (options.ai && needsAiRelevance(ranked)) {
        const top = ranked.filter(c => c.tier === "official").slice(0, 8);
        try {
            const { verdicts, usage } = await classifyRelevance(options.ai, { gameName: game.name, description: topic.discovery?.terms?.length ? `${topic.discovery.terms.join(" / ")} for ${topic.type}` : topic.type.replace(/-/g, " ") }, top);
            ranked = rankCandidates(applyRelevance(ranked, verdicts));
            ai = { used: true, verdicts: verdicts.length, usage };
        } catch (error) {
            ai = { used: false, verdicts: 0, error: error instanceof Error ? error.message : String(error) };
        }
    }

    return { candidates: ranked, official: publishableCandidates(ranked), queries: log, rejected, searchedWeb, unavailable, ai };
}
