/**
 * Pure helpers that mutate a loaded GameKnowledge document in memory.
 * The store stays a plain load/save boundary; all rules about events and
 * change records live here so they can be unit-tested without files.
 */
import { EventInput } from "./adapter";
import { Change, DatePrecision, Event, GameKnowledge, PublishState, SourceState, Topic, TopicState } from "./domain";
import { eventKey } from "./identity";

const COMPARED_FIELDS = ["label", "status", "at", "startAt", "endAt", "precision", "timezone"] as const;
type ComparedField = typeof COMPARED_FIELDS[number];

export function eventsForTopic(knowledge: GameKnowledge, topicType: string): Event[] {
    return knowledge.events.filter(e => e.topic === topicType);
}

export function findEvent(knowledge: GameKnowledge, key: string): Event | undefined {
    return knowledge.events.find(e => e.key === key);
}

export interface UpsertResult {
    event: Event;
    created: boolean;
    changes: Change[];
}

function describeEvent(event: Event): string {
    const when = event.at ?? event.startAt ?? "";
    return when ? `${event.label} @ ${when}` : event.label;
}

/**
 * Inserts the event or updates the stored copy.
 * - New event: appended with firstSeen = lastVerified = now, one Change (field "event").
 * - Existing, identical: only lastVerified moves; no Change (repeated runs stay quiet).
 * - Existing, different: one Change per changed field, then the field is applied.
 */
export function upsertEvent(knowledge: GameKnowledge, topic: Topic, input: EventInput, now: Date, reason: string): UpsertResult {
    const nowIso = now.toISOString();
    const key = eventKey(topic.game, topic.type, input.identity);
    const existing = findEvent(knowledge, key);
    const changes: Change[] = [];

    if (!existing) {
        const event: Event = {
            key,
            game: topic.game,
            topic: topic.type,
            kind: topic.kind,
            label: input.label,
            status: input.status,
            at: input.at,
            startAt: input.startAt,
            endAt: input.endAt,
            precision: input.precision,
            timezone: input.timezone,
            firstSeen: nowIso,
            lastVerified: nowIso,
            publishState: "published"
        };
        knowledge.events.push(event);
        changes.push({ entityKey: key, field: "event", oldValue: null, newValue: describeEvent(event), at: nowIso, reason, decision: "applied" });
        knowledge.changes.push(...changes);
        return { event, created: true, changes };
    }

    for (const field of COMPARED_FIELDS) {
        const before = existing[field];
        const after = input[field as ComparedField];
        if (before === after) continue;
        changes.push({
            entityKey: key,
            field,
            oldValue: before === undefined ? null : String(before),
            newValue: after === undefined ? null : String(after),
            at: nowIso,
            reason,
            decision: "applied"
        });
        (existing as unknown as Record<string, unknown>)[field] = after;
    }
    existing.lastVerified = nowIso;
    knowledge.changes.push(...changes);
    return { event: existing, created: false, changes };
}

/**
 * Applies a source's pointer to its current event (see AdapterOutcome.currentIdentity): later-dated published events
 * of the topic are held, and the named event is published again if it was held. Returns the Change records appended.
 */
export function applyCurrentPointer(knowledge: GameKnowledge, topic: Topic, identity: string, now: Date, reason: string): Change[] {
    const current = findEvent(knowledge, eventKey(topic.game, topic.type, identity));
    if (!current || !current.at) return [];
    const currentAt = Date.parse(current.at);
    const nowIso = now.toISOString();
    const changes: Change[] = [];
    const setState = (event: Event, state: PublishState) => {
        changes.push({ entityKey: event.key, field: "publishState", oldValue: event.publishState, newValue: state, at: nowIso, reason, decision: state === "held" ? "held" : "applied" });
        event.publishState = state;
    };
    if (current.publishState === "held") setState(current, "published");
    for (const event of eventsForTopic(knowledge, topic.type)) {
        if (event.key === current.key || event.publishState !== "published" || !event.at) continue;
        if (Date.parse(event.at) > currentAt) setState(event, "held");
    }
    knowledge.changes.push(...changes);
    return changes;
}

export function getSourceState(knowledge: GameKnowledge, sourceId: string): SourceState | undefined {
    return (knowledge.sources ?? []).find(s => s.id === sourceId);
}

/** Replaces (or adds) the fetch state for a source. Bookkeeping only; no Change record. */
export function putSourceState(knowledge: GameKnowledge, state: SourceState): void {
    if (!knowledge.sources) knowledge.sources = [];
    const index = knowledge.sources.findIndex(s => s.id === state.id);
    if (index >= 0) knowledge.sources[index] = state;
    else knowledge.sources.push(state);
}

/** Marks the events of a topic as verified now without recording a change. */
/**
 * Records what a run did for a topic beyond its events: when discovery searched, and whether AI work
 * was deferred by the budget (cleared by the next run that is not deferred). A topic with nothing to
 * record keeps no entry, so trackers that never discover or use AI leave their knowledge untouched.
 */
export function recordTopicRun(knowledge: GameKnowledge, topicType: string, run: { discoveryRanAt?: string; deferred?: { reason: "deferred_due_to_budget"; detail: string } }, now: Date): void {
    if (!knowledge.topicStates) knowledge.topicStates = [];
    const states = knowledge.topicStates;
    const index = states.findIndex(s => s.topic === topicType);
    const next: TopicState = { ...(index >= 0 ? states[index] : { topic: topicType }) };
    if (run.discoveryRanAt) next.lastDiscoveryAt = run.discoveryRanAt;
    if (run.deferred) next.deferred = { reason: run.deferred.reason, detail: run.deferred.detail, at: now.toISOString() };
    else delete next.deferred;
    if (next.lastDiscoveryAt === undefined && next.deferred === undefined) {
        if (index >= 0) states.splice(index, 1);
        return;
    }
    if (index >= 0) states[index] = next;
    else states.push(next);
}

export function touchEvents(events: Event[], now: Date): void {
    const nowIso = now.toISOString();
    for (const event of events) event.lastVerified = nowIso;
}

const DAY_MS = 86_400_000;

/**
 * Until when a scheduled event counts as upcoming: its instant, or the end of its UTC day when only
 * the day is known (a patch "on September 23" stays the next patch for all of September 23, as V1
 * kept today's patch). Undefined without an instant.
 */
export function upcomingUntil(event: { at?: string; precision: DatePrecision }): number | undefined {
    if (!event.at) return undefined;
    return Date.parse(event.at) + (event.precision === "day" ? DAY_MS : 0);
}

/** Scheduled events that are no longer upcoming (see upcomingUntil) become "ended". Returns the Change records appended. */
export function endPastScheduled(knowledge: GameKnowledge, topic: Topic, now: Date, reason: string): Change[] {
    const nowIso = now.toISOString();
    const changes: Change[] = [];
    for (const event of eventsForTopic(knowledge, topic.type)) {
        if (event.status !== "scheduled" || !event.at) continue;
        if ((upcomingUntil(event) ?? 0) > now.getTime()) continue;
        changes.push({ entityKey: event.key, field: "status", oldValue: "scheduled", newValue: "ended", at: nowIso, reason, decision: "applied" });
        event.status = "ended";
        event.lastVerified = nowIso;
    }
    knowledge.changes.push(...changes);
    return changes;
}
