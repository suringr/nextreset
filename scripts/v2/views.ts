/**
 * Compatibility views: derive today's `/data/<game>.<type>.json` shape
 * (ProviderResult from ../types) from stored knowledge, so app.js cannot tell
 * a V2 tracker from a V1 provider.
 *
 * Key order mirrors what the V1 providers emitted, so the published files stay
 * byte-for-byte comparable apart from values.
 */
import { FailureType, FreshResult, ProviderResult, StaleResult, UnavailableResult } from "../types";
import { Event, GameKnowledge, Topic } from "./domain";
import { eventsForTopic } from "./knowledge";

export type RunOutcome =
    | { ok: true; httpStatus?: number; fetchMode?: "http" | "browser" }
    | { ok: false; reason: string };

export interface ViewContext {
    now: Date;
    outcome: RunOutcome;
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
    const isUpcoming = (e: Event) => e.status === "scheduled" && Date.parse(e.at!) > now.getTime();

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
            source_url: topic.view.sourceUrl,
            confidence: topic.view.confidence,
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
        source_url: topic.view.sourceUrl,
        confidence: topic.view.confidence,
        ...(notes !== undefined ? { notes } : {}),
        reason: ctx.outcome.reason
    };
    return stale;
}
