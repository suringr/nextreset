/**
 * Generic evidence-based adapter: known sources -> (discovery) -> fetch ->
 * Gemini classification + extraction -> deterministic grounding -> events.
 *
 *   known sources     the topic's configured page (if any) and pages learned by
 *                     earlier runs, most trusted first
 *   fetch             smart fetch (conditional requests, validation, render); an
 *                     unchanged document stops here, with no model call
 *   budget            a changed document goes to the model only when its worst
 *                     case fits the AI budget (cost/budget.ts); otherwise the work
 *                     is deferred: the document is not marked as seen, stored
 *                     knowledge is served, and a later run retries
 *   classify          is this document the kind that answers the topic?
 *   extract + ground  every fact must be quoted verbatim and checked (ai/extraction.ts)
 *   verify            deterministic sanity rules on the grounded facts (below)
 *   discovery         only when known sources do not answer the open question,
 *                     and no more often than the topic's cadence (discovery/cadence.ts)
 *
 * The adapter never publishes from a non-official page: fetched documents must
 * land on one of the game's official domains, and only official candidates are
 * tried. Everything the run did is returned in `report` for logs and the
 * evaluation; nothing from the report is persisted.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter, AdapterContext, AdapterOutcome, EventInput, WorkStats } from "../adapter";
import { AiDocument, DocType, ExtractionResult, ExtractionTopic, GroundedItem, ItemKind, MAX_DOCUMENT_CHARS, classifyDocument, extractFacts } from "../ai/extraction";
import { AiJsonRequest, AiProvider, AiUsage, createAiProvider, readAiConfig } from "../ai/provider";
import { AiBudgetExceededError, AiGate, PlannedCall, createAiGate, currentRunId, readAiBudgetLimits } from "../cost/budget";
import { AiCallRecord, AiUsageLedger, utcDate } from "../cost/ledger";
import { discoveryDue } from "../discovery/cadence";
import { discoveredSourceId, knownSourcesFor, LearnInput } from "../discovery/learning";
import { DiscoveryResult, createSearchProviders, discoverSources, shouldDiscover } from "../discovery/discovery";
import { readSearchConfig, SearchProvider } from "../discovery/search-provider";
import { versionOf } from "../discovery/queries";
import { canonicalUrl, isOfficialUrl } from "../discovery/urls";
import { Claim, DiscoveryVia, Document, EventStatus, Game, SourceState, Topic } from "../domain";
import { FetchedDocument, smartFetch } from "../fetch/smart-fetch";
import { Transport, defaultTransport } from "../fetch/transport";
import { eventKey } from "../identity";
import { upcomingUntil } from "../knowledge";

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
    /**
     * Provides the AI provider (undefined when not configured) when the run passes no budget gate in the
     * context (tests, tools); it is then wrapped in a fresh in-memory gate. Defaults to GEMINI_API_KEY from the environment.
     */
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
    outcome: "events" | "unchanged" | "duplicate" | "unusable" | "not-official" | "no-ai" | "deferred" | "not-relevant" | "no-facts" | "no-answer";
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
    /** Model calls this topic made in this run, from the usage ledger (costs are estimates). */
    ai: { model?: string; calls: number; failures: number; repairs: number; retries: number; inputTokens: number; outputTokens: number; thoughtTokens: number; estimatedCostUsd: number };
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
/** `notAttempted`: the changed document was not read (no model, or the budget deferred it). That is not a failure of the page. */
interface AttemptFailure { ok: false; reason: string; notAttempted?: boolean }
type AttemptResult = AttemptSuccess | AttemptUnchanged | AttemptFailure;

const DAY_MS = 86_400_000;

/** Output caps of the calls one document may need (see ai/extraction.ts and discovery/relevance.ts). */
const CLASSIFY_MAX_OUTPUT_TOKENS = 1024;
const EXTRACT_MAX_OUTPUT_TOKENS = 16384;
const RELEVANCE_MAX_OUTPUT_TOKENS = 2048;
/** Room for system instructions, the topic block and a repair's corrections list, on top of the document. */
const PROMPT_ALLOWANCE_CHARS = 12_000;

/** The worst case for one document: classify, extract, and at most one repair, each at its output cap. */
export function documentCallPlan(textChars: number, titleChars = 0): PlannedCall[] {
    const promptChars = Math.min(textChars, MAX_DOCUMENT_CHARS) + titleChars + PROMPT_ALLOWANCE_CHARS;
    return [
        { promptChars, maxOutputTokens: CLASSIFY_MAX_OUTPUT_TOKENS },
        { promptChars, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS },
        { promptChars, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS }
    ];
}

/** The worst case for a discovery pass: a relevance tie-break plus one full-size candidate document. */
export function discoveryCallPlan(): PlannedCall[] {
    return [{ promptChars: PROMPT_ALLOWANCE_CHARS, maxOutputTokens: RELEVANCE_MAX_OUTPUT_TOKENS }, ...documentCallPlan(MAX_DOCUMENT_CHARS, 200)];
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

async function defaultAi(): Promise<AiProvider | undefined> {
    const config = readAiConfig();
    return config ? createAiProvider(config) : undefined;
}

function aiUsageReport(gate: AiGate, date: string, start: number, game: string, topic: string, model?: string): AiDiscoveryReport["ai"] {
    const records = gate.ledger.calls(date).slice(start).filter(r => r.game === game && r.topic === topic);
    const sum = (pick: (r: AiCallRecord) => number) => records.reduce((n, r) => n + pick(r), 0);
    return {
        model,
        calls: records.length,
        failures: records.filter(r => !r.success).length,
        repairs: records.filter(r => r.repair).length,
        retries: sum(r => r.retries),
        inputTokens: sum(r => r.inputTokens),
        outputTokens: sum(r => r.outputTokens),
        thoughtTokens: sum(r => r.thoughtTokens),
        estimatedCostUsd: sum(r => r.estimatedCostUsd)
    };
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

    // A day-precision date stays upcoming through its whole day, as V1 kept today's patch until midnight.
    const future = (upcomingUntil({ at: anchor.at, precision: anchor.precision }) ?? 0) > now.getTime();
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
        // The run's gate carries the daily budget. A standalone call (tests, tools) gets a fresh in-memory one.
        const gate: AiGate = ctx.ai ?? createAiGate({ ledger: AiUsageLedger.inMemory(), limits: readAiBudgetLimits(), runId: currentRunId(), loadProvider: deps.ai ?? defaultAi });
        const ai = await gate.providerFor(game.id, topic.type, now);
        const usageDate = utcDate(now);
        const ledgerStart = gate.ledger.calls(usageDate).length;
        const extractionTopic: ExtractionTopic = { game: game.id, gameName: game.name, type: topic.type, description: spec.description };

        const report: AiDiscoveryReport = { knownSources: [], attempts: [], ai: aiUsageReport(gate, usageDate, ledgerStart, game.id, topic.type, ai?.model) };
        const sourceStates: SourceState[] = [];
        const tried = new Set<string>();
        const failures: string[] = [];
        const work: WorkStats = { unchanged: 0, deterministic: 0, sentToAi: 0, deferred: 0 };
        // The first budget refusal of the run. Once the budget refuses, nothing more is sent to the model this run.
        const budget: { refusal?: AiBudgetExceededError } = {};
        // Content already read is never sent to the model again: the document the topic's knowledge was last
        // extracted from (the same page reached under another URL), and documents read earlier in this run.
        // Only the latest evidence counts as known: a page that reverts to older content is read again.
        const topicKeys = new Set(knowledge.events.filter(e => e.topic === topic.type).map(e => e.key));
        const latestEvidence = knowledge.claims
            .filter(c => topicKeys.has(c.eventKey))
            .sort((a, b) => b.extractedAt.localeCompare(a.extractedAt))[0]?.documentId;
        const readThisRun = new Map<string, string>();

        // Whether a page's verified events answer the topic's question (for a next-patch topic: an upcoming patch).
        const answeredWhen = topic.discovery?.answeredWhen ?? (topic.kind === "version" || topic.kind === "occurrence" ? "future-scheduled" : "usable-source");
        const answersTopic = (events: EventInput[]) => answeredWhen === "usable-source"
            ? events.length > 0
            : events.some(e => e.status === "scheduled" && (upcomingUntil(e) ?? 0) > now.getTime());

        const defer = (entry: AttemptReport, refusal: AiBudgetExceededError): AttemptFailure => {
            entry.outcome = "deferred";
            entry.reason = refusal.message;
            work.deferred++;
            if (!budget.refusal) budget.refusal = refusal;
            return { ok: false, reason: `${entry.url}: ${refusal.message}`, notAttempted: true };
        };

        const attempt = async (url: string, via: DiscoveryVia, stateId: string): Promise<AttemptResult> => {
            const started = Date.now();
            const entry: AttemptReport = { url, via, outcome: "unusable", elapsedMs: 0 };
            report.attempts.push(entry);
            const finish = <T extends AttemptResult>(result: T): T => { entry.elapsedMs = Date.now() - started; return result; };
            tried.add(url);

            const stored = ctx.getSourceState(stateId);
            const previous = stored && stored.url === url ? stored : undefined;
            const fetched = await smartFetch(url, { expect: { kind: "html", allowDomains: domains, minWords: 120 }, allowRender: true, previous, transport, label: `${game.id}-${topic.type}`, now });
            const state: SourceState = { id: stateId, url, ...fetched.state };
            const last = fetched.attempts[fetched.attempts.length - 1];
            entry.fetch = { mode: last?.mode ?? "http", status: last?.status ?? 0, verdict: fetched.verdict?.code, attempts: fetched.attempts.length };
            if (fetched.outcome === "unusable") {
                sourceStates.push(state);
                entry.reason = fetched.error ?? fetched.verdict?.reason ?? "fetch failed";
                return finish({ ok: false, reason: `${url}: ${entry.reason}` });
            }
            const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };
            if (fetched.outcome === "unchanged") {
                sourceStates.push(state);
                work.unchanged++;
                entry.outcome = "unchanged";
                return finish({ ok: true, unchanged: true, fetch });
            }
            const document = fetched.document!;
            entry.finalUrl = document.finalUrl;
            if (!isOfficialUrl(document.finalUrl, domains)) {
                sourceStates.push(state);
                entry.outcome = "not-official";
                entry.reason = `final URL ${document.finalUrl} is not on an official domain`;
                return finish({ ok: false, reason: entry.reason });
            }
            if (document.textHash === latestEvidence) {
                sourceStates.push(state);
                work.unchanged++;
                entry.outcome = "unchanged";
                entry.reason = "same content as the latest evidence already extracted";
                return finish({ ok: true, unchanged: true, fetch });
            }
            const readAt = readThisRun.get(document.textHash);
            if (readAt) {
                sourceStates.push(state);
                work.unchanged++;
                entry.outcome = "duplicate";
                entry.reason = `same content as ${readAt}, already read this run`;
                return finish({ ok: false, reason: `${url}: ${entry.reason}` });
            }

            // The document changed and needs the model. Its new fetch state (text hash, validators) is kept only
            // once the model has read it, so work skipped for lack of a model or of budget is retried by a later run.
            if (!ai) {
                entry.outcome = "no-ai";
                entry.reason = "AI provider not configured (GEMINI_API_KEY missing)";
                return finish({ ok: false, reason: entry.reason, notAttempted: true });
            }
            const aiDoc: AiDocument = { url: document.finalUrl, title: document.title, text: document.text };
            const verdict = gate.check(game.id, topic.type, now, documentCallPlan(aiDoc.text.length, aiDoc.title?.length ?? 0));
            if (!verdict.ok) return finish(defer(entry, new AiBudgetExceededError(verdict.reason, verdict.detail)));

            // A refusal inside any call (the repair included, which extraction otherwise treats as best effort)
            // defers the whole document: a partial answer is never published because the budget ran out.
            const calls: { refusal?: AiBudgetExceededError } = {};
            const guarded: AiProvider = {
                name: ai.name,
                model: ai.model,
                generateJson: async (request: AiJsonRequest) => {
                    try {
                        return await ai.generateJson(request);
                    } catch (error) {
                        if (error instanceof AiBudgetExceededError && !calls.refusal) calls.refusal = error;
                        throw error;
                    }
                }
            };
            work.sentToAi++;
            readThisRun.set(document.textHash, url);

            const classified = await classifyDocument(guarded, extractionTopic, aiDoc, { now }).catch((error: unknown) => {
                if (calls.refusal) return undefined;
                throw error;
            });
            if (!classified) return finish(defer(entry, calls.refusal!));
            const { classification } = classified;
            entry.classification = { relevant: classification.relevant, docType: classification.docType, summary: classification.summary };
            if (!classification.relevant || !spec.docTypes.includes(classification.docType)) {
                sourceStates.push(state);
                entry.outcome = "not-relevant";
                entry.reason = `classified as ${classification.docType}${classification.relevant ? "" : ", not relevant"}`;
                return finish({ ok: false, reason: `${document.finalUrl}: ${entry.reason}` });
            }

            const extraction = await extractFacts(guarded, extractionTopic, aiDoc, { now }).catch((error: unknown) => {
                if (calls.refusal) return undefined;
                throw error;
            });
            if (!extraction || calls.refusal) return finish(defer(entry, calls.refusal!));
            sourceStates.push(state);
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
            if (!answersTopic(events)) {
                // Verified but historical: a page listing only past patches must not win and publish a past patch as fresh.
                entry.outcome = "no-answer";
                entry.events = events.length;
                entry.reason = "its verified facts list no upcoming event";
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
            if (!result.ok) {
                // Without a model or budget nothing further can be read this run; the page itself did not fail.
                if (result.notAttempted) break;
                failures.push(source.url);
                continue;
            }
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

        // 2. Discovery, only when the known sources do not answer the open question, and only when due.
        const learnedSuccesses: LearnInput[] = [];
        let discoveryRanAt: string | undefined;
        if (!winner && budget.refusal) {
            report.decision = { discover: false, reason: "a changed page is waiting for AI budget, so discovery waits too" };
        } else if (!winner && !ai) {
            // Nothing could be extracted from a discovered page either; do not spend fetches and renders on it.
            report.decision = { discover: false, reason: "AI provider not configured (GEMINI_API_KEY missing); discovery skipped" };
        } else if (!winner) {
            const needed = shouldDiscover({ topic, knowledge, now, knownSources: known.length, usableKnownSources: usable });
            const due = needed.discover ? discoveryDue({ topic, knowledge, now }) : undefined;
            // Reading one full-size candidate must fit; the optional relevance tie-break is used only when it fits on top.
            const affordable = due?.due ? gate.check(game.id, topic.type, now, documentCallPlan(MAX_DOCUMENT_CHARS, 200)) : undefined;
            if (!needed.discover || !due) {
                report.decision = needed;
            } else if (!due.due) {
                report.decision = { discover: false, reason: `${needed.reason}, but discovery is not due: ${due.reason}` };
            } else if (affordable && !affordable.ok) {
                const refusal = new AiBudgetExceededError(affordable.reason, affordable.detail);
                budget.refusal = refusal;
                report.decision = { discover: false, reason: `${needed.reason}, but discovery is deferred: ${refusal.message}` };
            } else {
                report.decision = { discover: true, reason: `${needed.reason} (${due.reason})` };
                const providers = deps.search ? deps.search(game, now) : createSearchProviders(game, readSearchConfig(), { transport, now });
                const relevanceAi = gate.check(game.id, topic.type, now, discoveryCallPlan()).ok ? ai : undefined;
                const discovery = await discoverSources({ game, topic, knowledge, now, officialProviders: providers.official, webProvider: providers.web, transport, ai: relevanceAi });
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
                    if (!result.ok) {
                        if (result.notAttempted) break;
                        failures.push(candidate.url);
                    }
                }
                // A search whose candidates were deferred has not really run: the next run searches again.
                if (!budget.refusal) discoveryRanAt = now.toISOString();
            }
        }

        report.ai = aiUsageReport(gate, usageDate, ledgerStart, game.id, topic.type, ai?.model);
        const shared = { sourceStates, work, report: report as unknown as Record<string, unknown>, ...(discoveryRanAt ? { discoveryRanAt } : {}) };

        if (winner) {
            const finalUrl = canonicalUrl(winner.document.finalUrl) ?? winner.document.finalUrl;
            // A configured or learned page that answered is (re)learned under its final URL, so it survives config changes and redirects.
            // Compare canonical forms: a discovered page's final URL may differ only by a trailing slash.
            if (!learnedSuccesses.some(l => (canonicalUrl(l.url) ?? l.url) === finalUrl)) {
                learnedSuccesses.push({ url: finalUrl, tier: "official", via: winner.via, title: winner.document.title || undefined });
            }
            const confidence = confidenceFor(winner);
            // Recorded with the evidence so a later run that only re-verifies unchanged content keeps it.
            winner.docRecord.confidence = confidence.level;
            report.winner = { url: winner.document.finalUrl, via: winner.via, tier: "official" };
            report.confidence = confidence;
            return {
                events: winner.events,
                fetch: winner.fetch,
                documents: [winner.docRecord],
                claims: winner.claims,
                learned: { successes: learnedSuccesses, failures },
                confidence: confidence.level,
                ...shared
            };
        }
        // Work the budget deferred: nothing new is published, stored knowledge is served, and a later run retries.
        if (budget.refusal) {
            const detail = budget.refusal.message;
            return { events: [], failure: `deferred_due_to_budget: ${detail}`, deferred: { reason: "deferred_due_to_budget", detail }, learned: { successes: [], failures }, ...shared };
        }
        // An unchanged page is a success only while stored knowledge still answers the question; otherwise the
        // failed search for an answer surfaces, and the pipeline serves stored knowledge as stale.
        const storedAnswers = !shouldDiscover({ topic, knowledge, now, knownSources: Math.max(known.length, 1), usableKnownSources: 1 }).discover;
        if (unchangedFetch && storedAnswers) {
            return { events: [], unchanged: true, fetch: unchangedFetch, learned: { successes: [], failures }, ...shared };
        }
        let reason: string;
        if (report.attempts.length > 0) {
            reason = report.attempts.map(a => `${a.url}: ${a.reason ?? a.outcome}`).join("; ");
            if (ai && report.decision && !report.decision.discover) reason = `${reason}; discovery skipped: ${report.decision.reason}`;
        } else if (report.discovery) {
            const d = report.discovery;
            reason = `no official page found by discovery (${d.candidates.length} candidate(s), web ${d.searchedWeb ? "searched" : "not searched"}${d.unavailable.length > 0 ? `, unavailable: ${d.unavailable.join(", ")}` : ""})`;
        } else {
            reason = report.decision?.reason ?? "no known source and nothing discovered";
        }
        if (unchangedFetch) reason = `stored knowledge has no upcoming event and no source answered (${reason})`;
        return { events: [], failure: reason, learned: { successes: [], failures }, ...shared };
    };
}

/** Usage summary type re-exported for callers that render reports. */
export type { AiUsage };
