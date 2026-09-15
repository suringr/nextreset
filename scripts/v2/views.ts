/**
 * Compatibility views: derive today's `/data/<game>.<type>.json` shape
 * (ProviderResult from ../types) from stored knowledge, so app.js cannot tell
 * a V2 tracker from a V1 provider.
 *
 * Key order mirrors what the V1 providers emitted, so the published files stay
 * byte-for-byte comparable apart from values.
 */
import { Confidence, FailureType, FreshResult, ProviderResult, StaleResult, UnavailableResult } from "../types";
import { Event, GameKnowledge, Topic } from "./domain";
import { eventsForTopic, upcomingUntil } from "./knowledge";

export type RunOutcome =
    | { ok: true; httpStatus?: number; fetchMode?: "http" | "browser" }
    | { ok: false; reason: string };

export interface ViewContext {
    now: Date;
    outcome: RunOutcome;
    /** Confidence computed by this run's adapter; the topic's static label otherwise. */
    confidence?: Confidence;
}

/**
 * The attribution link for an event: the page its most recent claim came from
 * (evidence-based topics), else the topic's configured link. Topics whose evidence is machine data opt out
 * with `view.linkEvidence: false`.
 */
export function sourceUrlFor(event: Event, knowledge: GameKnowledge, topic: Topic): string {
    if (topic.view.linkEvidence === false) return topic.view.sourceUrl;
    const claims = knowledge.claims.filter(c => c.eventKey === event.key).sort((a, b) => b.extractedAt.localeCompare(a.extractedAt));
    for (const claim of claims) {
        // A claim taken from a feed names the page it is about (a post); otherwise the document itself is that page.
        if (claim.linkUrl) return claim.linkUrl;
        const doc = knowledge.documents.find(d => d.id === claim.documentId);
        if (doc) return doc.url;
    }
    return topic.view.sourceUrl;
}

/** The confidence recorded with the event's most recent evidence document, if any. */
export function evidenceConfidenceFor(event: Event, knowledge: GameKnowledge): Confidence | undefined {
    const claims = knowledge.claims.filter(c => c.eventKey === event.key).sort((a, b) => b.extractedAt.localeCompare(a.extractedAt));
    for (const claim of claims) {
        const doc = knowledge.documents.find(d => d.id === claim.documentId);
        if (doc?.confidence) return doc.confidence;
    }
    return undefined;
}

/**
 * The event a topic currently publishes: the earliest scheduled event still in
 * the future, otherwise the latest of everything else by `at`. Only *scheduled*
 * events are ever treated as "future"; an observed event whose timestamp sits a
 * little ahead of `now` (source clock skew, or a change that landed while the
 * request was in flight) is still the latest observation and stays selectable.
 * Held events are ignored. Period events without `at` are not selectable yet.
 */
export function selectCurrentEvent(events: Event[], now: Date): Event | undefined {
    const candidates = events.filter(e => e.publishState === "published" && typeof e.at === "string");
    const byAt = (a: Event, b: Event) => Date.parse(a.at!) - Date.parse(b.at!);
    // A day-precision event stays upcoming through its whole day (see upcomingUntil).
    const isUpcoming = (e: Event) => e.status === "scheduled" && (upcomingUntil(e) ?? 0) > now.getTime();

    const upcoming = candidates.filter(isUpcoming).sort(byAt);
    if (upcoming.length > 0) return upcoming[0];

    const rest = candidates.filter(e => !isUpcoming(e)).sort(byAt);
    return rest.length > 0 ? rest[rest.length - 1] : undefined;
}

function renderNotes(template: string | undefined, label: string): string | undefined {
    if (!template) return undefined;
    return template.replace(/\{label\}/g, label);
}

export function unavailableResult(topic: Topic, now: Date, explanation: string): UnavailableResult {
    return {
        provider_id: topic.game,
        game: topic.game,
        type: topic.type,
        title: topic.view.title,
        status: "unavailable",
        nextEventUtc: null,
        failure_type: FailureType.Unavailable,
        explanation,
        fetched_at_utc: now.toISOString()
    };
}

export function deriveProviderResult(topic: Topic, knowledge: GameKnowledge, ctx: ViewContext): ProviderResult {
    const event = selectCurrentEvent(eventsForTopic(knowledge, topic.type), ctx.now);
    const nowIso = ctx.now.toISOString();

    if (!event) {
        const explanation = ctx.outcome.ok ? "No event known for this topic yet" : ctx.outcome.reason;
        return unavailableResult(topic, ctx.now, explanation);
    }

    const notes = renderNotes(topic.view.notes, event.label);
    const sourceUrl = sourceUrlFor(event, knowledge, topic);
    // A run that re-verified unchanged evidence keeps the confidence computed when that evidence was extracted.
    const confidence = ctx.confidence ?? evidenceConfidenceFor(event, knowledge) ?? topic.view.confidence;

    if (ctx.outcome.ok) {
        const fresh: FreshResult = {
            provider_id: topic.game,
            game: topic.game,
            type: topic.type,
            title: topic.view.title,
            status: "fresh",
            nextEventUtc: event.at!,
            fetched_at_utc: nowIso,
            last_success_at_utc: nowIso,
            source_url: sourceUrl,
            confidence,
            ...(ctx.outcome.httpStatus !== undefined ? { http_status: ctx.outcome.httpStatus } : {}),
            ...(ctx.outcome.fetchMode !== undefined ? { fetch_mode: ctx.outcome.fetchMode } : {}),
            ...(notes !== undefined ? { notes } : {})
        };
        return fresh;
    }

    const stale: StaleResult = {
        provider_id: topic.game,
        game: topic.game,
        type: topic.type,
        title: topic.view.title,
        status: "stale",
        nextEventUtc: event.at!,
        fetched_at_utc: nowIso,
        last_success_at_utc: event.lastVerified,
        source_url: sourceUrl,
        confidence,
        ...(notes !== undefined ? { notes } : {}),
        reason: ctx.outcome.reason
    };
    return stale;
}
