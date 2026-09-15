/**
 * Generic evidence-based adapter: known sources -> (discovery) -> fetch ->
 * Gemini classification + extraction -> deterministic grounding -> events.
 *
 *   known sources     the topic's configured page (if any) and pages learned by
 *                     earlier runs, most trusted first
 *   fetch             smart fetch (conditional requests, validation, render)
 *   classify          is this document the kind that answers the topic?
 *   extract + ground  every fact must be quoted verbatim and checked (ai/extraction.ts)
 *   verify            deterministic sanity rules on the grounded facts (below)
 *   discovery         only when known sources do not answer the open question
 *
 * The adapter never publishes from a non-official page: fetched documents must
 * land on one of the game's official domains, and only official candidates are
 * tried. Everything the run did is returned in `report` for logs and the
 * evaluation; nothing from the report is persisted.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter, AdapterContext, AdapterOutcome, EventInput } from "../adapter";
import { AiDocument, DocType, ExtractionResult, ExtractionTopic, GroundedItem, ItemKind, classifyDocument, extractFacts } from "../ai/extraction";
import { AiProvider, AiUsage, AiUsageTracker, TrackedAiProvider, createAiProvider, readAiConfig } from "../ai/provider";
import { discoveredSourceId, knownSourcesFor, LearnInput } from "../discovery/learning";
import { DiscoveryResult, createSearchProviders, discoverSources, shouldDiscover } from "../discovery/discovery";
import { readSearchConfig, SearchProvider } from "../discovery/search-provider";
import { versionOf } from "../discovery/queries";
import { canonicalUrl, isOfficialUrl } from "../discovery/urls";
import { Claim, DiscoveryVia, Document, EventStatus, Game, SourceState, Topic } from "../domain";
import { FetchedDocument, smartFetch } from "../fetch/smart-fetch";
import { Transport, defaultTransport } from "../fetch/transport";
import { eventKey } from "../identity";

export interface AiTopicSpec {
    /** What matters, in the model's terms ("the release date of each League of Legends patch"). */
    description: string;
    /** Document types that can answer the topic; others are not extracted from. */
    docTypes: DocType[];
    /** Item kinds accepted from the extraction. */
    itemKinds: ItemKind[];
}

export interface AiDiscoveryDeps {
    transport?: Transport;
    /** Provides the AI provider (undefined when not configured). Defaults to GEMINI_API_KEY from the environment. */
    ai?: () => Promise<AiProvider | undefined>;
    /** Provides the search providers for a game. Defaults to the game's discovery configuration and SEARCH_* env. */
    search?: (game: Game, now: Date) => { official: SearchProvider[]; web?: SearchProvider };
    /** Discovered candidates tried per run (default 3). */
    maxCandidates?: number;
    /** Sanity window around now for extracted instants, in days (default 730). */
    maxDaysFromNow?: number;
}

/** Everything one fetch+extract attempt produced or failed on; reported, never persisted. */
export interface AttemptReport {
    url: string;
    finalUrl?: string;
    via: DiscoveryVia;
    outcome: "events" | "unchanged" | "unusable" | "not-official" | "no-ai" | "not-relevant" | "no-facts";
    reason?: string;
    fetch?: { mode: "http" | "browser"; status: number; verdict?: string; attempts: number };
    classification?: { relevant: boolean; docType: string; summary: string };
    extraction?: { items: number; fields: number; accepted: number; rejected: number; attempts: number; repaired: boolean; rejections: Array<{ identity: string; field: string; reason: string }> };
    events?: number;
    elapsedMs: number;
}

export interface AiDiscoveryReport {
    knownSources: Array<{ url: string; via: "config" | "learned" }>;
    attempts: AttemptReport[];
    decision?: { discover: boolean; reason: string };
    discovery?: {
        queries: DiscoveryResult["queries"];
        candidates: Array<{ url: string; tier: string; via: string; score: number; reasons: string[] }>;
        rejected: DiscoveryResult["rejected"];
        searchedWeb: boolean;
        unavailable: string[];
        ai?: DiscoveryResult["ai"];
    };
    winner?: { url: string; via: DiscoveryVia; tier: "official" };
    confidence?: { level: Confidence; reasons: string[] };
    ai: { model?: string; calls: number; failures: number; inputTokens: number; outputTokens: number; thoughtTokens: number };
}

interface AttemptSuccess {
    ok: true;
    unchanged: false;
    document: FetchedDocument;
    docRecord: Document;
    events: EventInput[];
    claims: Claim[];
    extraction: ExtractionResult;
    fetch: { httpStatus: number; mode: "http" | "browser" };
}
interface AttemptUnchanged { ok: true; unchanged: true; fetch: { httpStatus: number; mode: "http" | "browser" } }
interface AttemptFailure { ok: false; reason: string }
type AttemptResult = AttemptSuccess | AttemptUnchanged | AttemptFailure;

const DAY_MS = 86_400_000;

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

async function defaultAi(): Promise<AiProvider | undefined> {
    const config = readAiConfig();
    return config ? createAiProvider(config) : undefined;
}

/** Maps a grounded extraction item to an event input and its claims; undefined when it cannot become an event. */
export function eventFromItem(item: GroundedItem, topic: Topic, spec: AiTopicSpec, documentId: string, now: Date, maxDaysFromNow: number): { event: EventInput; claims: Claim[] } | { skipped: string } {
    if (!spec.itemKinds.includes(item.kind)) return { skipped: `kind ${item.kind} not accepted` };
    const at = item.facts.find(f => f.field === "at");
    const startAt = item.facts.find(f => f.field === "startAt");
    const endAt = item.facts.find(f => f.field === "endAt");
    const anchor = at ?? startAt;
    if (!anchor) return { skipped: "no accepted date fact" };
    const distance = Math.abs(Date.parse(anchor.at) - now.getTime()) / DAY_MS;
    if (distance > maxDaysFromNow) return { skipped: `instant ${anchor.at} is ${Math.round(distance)} days from now` };

    let key: string;
    try {
        key = eventKey(topic.game, topic.type, item.identity);
    } catch (error) {
        return { skipped: `identity cannot be normalized: ${error instanceof Error ? error.message : String(error)}` };
    }

    const future = Date.parse(anchor.at) > now.getTime();
    let status: EventStatus;
    if (item.status === "ended") status = "ended";
    else if (future) status = "scheduled";
    else status = topic.kind === "occurrence" ? "ended" : "observed";

    const event: EventInput = {
        identity: item.identity,
        // A version is published as its number ("Patch {label}" -> "Patch 26.19"), taken from the grounded identity.
        label: topic.kind === "version" ? (versionOf(item.identity) ?? item.identity) : (item.label || item.identity),
        status,
        precision: anchor.precision,
        ...(anchor.timezone ? { timezone: anchor.timezone } : {})
    };
    if (topic.kind === "period") {
        event.startAt = (startAt ?? at)!.at;
        if (endAt) event.endAt = endAt.at;
    } else {
        event.at = anchor.at;
        if (topic.kind === "occurrence" && endAt) event.endAt = endAt.at;
    }

    const claims: Claim[] = item.facts.map(f => ({
        id: sha(`${documentId}|${key}|${f.field}|${f.at}|${f.quote}`).slice(0, 24),
        documentId,
        eventKey: key,
        field: f.field,
        value: f.at,
        method: "ai",
        quote: f.quote,
        extractedAt: now.toISOString()
    }));
    return { event, claims };
}

/** Deterministic confidence for what this run publishes, with the reasons. */
export function confidenceFor(winner: { via: DiscoveryVia; document: FetchedDocument; extraction: ExtractionResult; events: EventInput[] }): { level: Confidence; reasons: string[] } {
    const reasons: string[] = [];
    let level = Confidence.High;
    const demote = (why: string) => { level = Confidence.Medium; reasons.push(why); };
    reasons.push(`official page ${winner.document.finalUrl} (found via ${winner.via})`);
    reasons.push(`${winner.events.length} event(s) from ${winner.extraction.grounded.stats.accepted} quoted, verified fact(s)`);
    const dayOnly = winner.events.filter(e => e.precision === "day").length;
    if (dayOnly > 0) reasons.push(`${dayOnly} event(s) known to the day only (page states no time)`);
    const inferred = winner.extraction.grounded.items.flatMap(i => i.facts).filter(f => f.yearInferred).length;
    if (inferred > 0) demote(`${inferred} fact(s) with the year inferred from the page's own dates`);
    if (winner.extraction.repaired) demote("the model's quotes had to be repaired once");
    if (winner.via === "secondary-link") demote("page reached through a non-official page's link");
    if (winner.via === "web") demote("page found by web search rather than an official channel");
    if (winner.document.mode === "browser") reasons.push("content required a browser render");
    return { level, reasons };
}

export function createAiDiscoveryAdapter(spec: AiTopicSpec, deps: AiDiscoveryDeps = {}): Adapter {
    const maxCandidates = deps.maxCandidates ?? 3;
    const maxDaysFromNow = deps.maxDaysFromNow ?? 730;

    return async (ctx: AdapterContext): Promise<AdapterOutcome> => {
        const { game, topic, now, knowledge } = ctx;
        const transport = deps.transport ?? defaultTransport();
        const domains = game.discovery?.officialDomains ?? [];
        const tracker = new AiUsageTracker();
        const rawAi = await (deps.ai ?? defaultAi)();
        const ai = rawAi ? new TrackedAiProvider(rawAi, tracker) : undefined;
        const extractionTopic: ExtractionTopic = { game: game.id, gameName: game.name, type: topic.type, description: spec.description };

        const report: AiDiscoveryReport = { knownSources: [], attempts: [], ai: { model: rawAi?.model, calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0 } };
        const sourceStates: SourceState[] = [];
        const tried = new Set<string>();
        const failures: string[] = [];

        const attempt = async (url: string, via: DiscoveryVia, stateId: string): Promise<AttemptResult> => {
            const started = Date.now();
            const entry: AttemptReport = { url, via, outcome: "unusable", elapsedMs: 0 };
            report.attempts.push(entry);
            const finish = <T extends AttemptResult>(result: T): T => { entry.elapsedMs = Date.now() - started; return result; };
            tried.add(url);

            const stored = ctx.getSourceState(stateId);
            const previous = stored && stored.url === url ? stored : undefined;
            const fetched = await smartFetch(url, { expect: { kind: "html", allowDomains: domains, minWords: 120 }, allowRender: true, previous, transport, label: `${game.id}-${topic.type}`, now });
            sourceStates.push({ id: stateId, url, ...fetched.state });
            const last = fetched.attempts[fetched.attempts.length - 1];
            entry.fetch = { mode: last?.mode ?? "http", status: last?.status ?? 0, verdict: fetched.verdict?.code, attempts: fetched.attempts.length };
            if (fetched.outcome === "unusable") {
                entry.reason = fetched.error ?? fetched.verdict?.reason ?? "fetch failed";
                return finish({ ok: false, reason: `${url}: ${entry.reason}` });
            }
            const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };
            if (fetched.outcome === "unchanged") {
                entry.outcome = "unchanged";
                return finish({ ok: true, unchanged: true, fetch });
            }
            const document = fetched.document!;
            entry.finalUrl = document.finalUrl;
            if (!isOfficialUrl(document.finalUrl, domains)) {
                entry.outcome = "not-official";
                entry.reason = `final URL ${document.finalUrl} is not on an official domain`;
                return finish({ ok: false, reason: entry.reason });
            }
            if (!ai) {
                entry.outcome = "no-ai";
                entry.reason = "AI provider not configured (GEMINI_API_KEY missing)";
                return finish({ ok: false, reason: entry.reason });
            }

            const aiDoc: AiDocument = { url: document.finalUrl, title: document.title, text: document.text };
            const { classification } = await classifyDocument(ai, extractionTopic, aiDoc, { now });
            entry.classification = { relevant: classification.relevant, docType: classification.docType, summary: classification.summary };
            if (!classification.relevant || !spec.docTypes.includes(classification.docType)) {
                entry.outcome = "not-relevant";
                entry.reason = `classified as ${classification.docType}${classification.relevant ? "" : ", not relevant"}`;
                return finish({ ok: false, reason: `${document.finalUrl}: ${entry.reason}` });
            }

            const extraction = await extractFacts(ai, extractionTopic, aiDoc, { now });
            const g = extraction.grounded;
            entry.extraction = { items: g.items.length, fields: g.stats.fields, accepted: g.stats.accepted, rejected: g.stats.rejected, attempts: extraction.attempts, repaired: extraction.repaired, rejections: g.rejected.map(r => ({ identity: r.identity, field: r.field, reason: r.reason })) };

            const docRecord: Document = { id: document.textHash, url: document.finalUrl, sourceId: stateId, fetchedAt: document.fetchedAt, title: document.title || undefined, fetchMode: document.mode };
            const events: EventInput[] = [];
            const claims: Claim[] = [];
            const seenKeys = new Set<string>();
            for (const item of g.items) {
                const mapped = eventFromItem(item, topic, spec, docRecord.id, now, maxDaysFromNow);
                if ("skipped" in mapped) {
                    entry.extraction.rejections.push({ identity: item.identity, field: "at", reason: mapped.skipped });
                    continue;
                }
                const key = mapped.claims[0]?.eventKey ?? eventKey(topic.game, topic.type, mapped.event.identity);
                if (seenKeys.has(key)) continue; // the first grounded occurrence of an identity wins
                seenKeys.add(key);
                events.push(mapped.event);
                claims.push(...mapped.claims);
            }
            if (events.length === 0) {
                entry.outcome = "no-facts";
                entry.reason = "no grounded, verifiable facts";
                return finish({ ok: false, reason: `${document.finalUrl}: ${entry.reason}` });
            }
            entry.outcome = "events";
            entry.events = events.length;
            return finish({ ok: true, unchanged: false, document, docRecord, events, claims, extraction, fetch });
        };

        // 1. Known sources: configured page first, then learned pages.
        const known = knownSourcesFor(game, topic, knowledge);
        report.knownSources = known.map(k => ({ url: k.url, via: k.via }));
        let winner: (AttemptSuccess & { via: DiscoveryVia }) | undefined;
        let unchangedFetch: AttemptUnchanged["fetch"] | undefined;
        let usable = 0;
        for (const source of known) {
            const stateId = source.via === "config" ? topic.sourceId : discoveredSourceId(topic.type, source.url);
            const result = await attempt(source.url, source.via, stateId);
            if (!result.ok) { failures.push(source.url); continue; }
            usable++;
            if (!result.unchanged) {
                winner = { ...result, via: source.via };
                break;
            }
            unchangedFetch = unchangedFetch ?? result.fetch;
            // An unchanged page whose stored knowledge still answers the question settles the run;
            // otherwise the next known page (or discovery) gets its turn.
            if (!shouldDiscover({ topic, knowledge, now, knownSources: known.length, usableKnownSources: usable }).discover) break;
        }

        // 2. Discovery, only when the known sources do not answer the open question.
        const learnedSuccesses: LearnInput[] = [];
        if (!winner && !ai) {
            // Nothing could be extracted from a discovered page either; do not spend fetches and renders on it.
            report.decision = { discover: false, reason: "AI provider not configured (GEMINI_API_KEY missing); discovery skipped" };
        } else if (!winner) {
            const decision = shouldDiscover({ topic, knowledge, now, knownSources: known.length, usableKnownSources: usable });
            report.decision = decision;
            if (decision.discover) {
                const providers = deps.search ? deps.search(game, now) : createSearchProviders(game, readSearchConfig(), { transport, now });
                const discovery = await discoverSources({ game, topic, knowledge, now, officialProviders: providers.official, webProvider: providers.web, transport, ai });
                report.discovery = {
                    queries: discovery.queries,
                    candidates: discovery.candidates.slice(0, 12).map(c => ({ url: c.url, tier: c.tier, via: c.via, score: c.score, reasons: c.reasons })),
                    rejected: discovery.rejected,
                    searchedWeb: discovery.searchedWeb,
                    unavailable: discovery.unavailable,
                    ai: discovery.ai
                };
                for (const candidate of discovery.official.slice(0, maxCandidates)) {
                    if (tried.has(candidate.url)) continue;
                    const result = await attempt(candidate.url, candidate.via, discoveredSourceId(topic.type, candidate.url));
                    if (result.ok && !result.unchanged) {
                        winner = { ...result, via: candidate.via };
                        learnedSuccesses.push({ url: result.document.finalUrl, tier: "official", via: candidate.via, query: candidate.query, title: candidate.title ?? result.document.title });
                        break;
                    }
                    if (!result.ok) failures.push(candidate.url);
                }
            }
        }

        const usage = tracker.summary();
        report.ai = { model: rawAi?.model, calls: usage.calls, failures: usage.failures, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, thoughtTokens: usage.thoughtTokens };

        if (winner) {
            const finalUrl = canonicalUrl(winner.document.finalUrl) ?? winner.document.finalUrl;
            // A configured or learned page that answered is (re)learned under its final URL, so it survives config changes and redirects.
            // Compare canonical forms: a discovered page's final URL may differ only by a trailing slash.
            if (!learnedSuccesses.some(l => (canonicalUrl(l.url) ?? l.url) === finalUrl)) {
                learnedSuccesses.push({ url: finalUrl, tier: "official", via: winner.via, title: winner.document.title || undefined });
            }
            const confidence = confidenceFor(winner);
            report.winner = { url: winner.document.finalUrl, via: winner.via, tier: "official" };
            report.confidence = confidence;
            return {
                events: winner.events,
                fetch: winner.fetch,
                sourceStates,
                documents: [winner.docRecord],
                claims: winner.claims,
                learned: { successes: learnedSuccesses, failures },
                confidence: confidence.level,
                report: report as unknown as Record<string, unknown>
            };
        }
        if (unchangedFetch) {
            return { events: [], unchanged: true, fetch: unchangedFetch, sourceStates, learned: { successes: [], failures }, report: report as unknown as Record<string, unknown> };
        }
        let reason: string;
        if (report.attempts.length > 0) {
            reason = report.attempts.map(a => `${a.url}: ${a.reason ?? a.outcome}`).join("; ");
        } else if (report.discovery) {
            const d = report.discovery;
            reason = `no official page found by discovery (${d.candidates.length} candidate(s), web ${d.searchedWeb ? "searched" : "not searched"}${d.unavailable.length > 0 ? `, unavailable: ${d.unavailable.join(", ")}` : ""})`;
        } else {
            reason = report.decision?.reason ?? "no known source and nothing discovered";
        }
        return { events: [], failure: reason, sourceStates, learned: { successes: [], failures }, report: report as unknown as Record<string, unknown> };
    };
}

/** Usage summary type re-exported for callers that render reports. */
export type { AiUsage };
