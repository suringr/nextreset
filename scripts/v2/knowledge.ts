/**
 * Pure helpers that mutate a loaded GameKnowledge document in memory.
 * The store stays a plain load/save boundary; all rules about events and
 * change records live here so they can be unit-tested without files.
 */
import { EventInput } from "./adapter";
import { Change, Event, GameKnowledge, Topic } from "./domain";
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

/** Scheduled events whose instant has passed become "ended". Returns the Change records appended. */
export function endPastScheduled(knowledge: GameKnowledge, topic: Topic, now: Date, reason: string): Change[] {
    const nowIso = now.toISOString();
    const changes: Change[] = [];
    for (const event of eventsForTopic(knowledge, topic.type)) {
        if (event.status !== "scheduled" || !event.at) continue;
        if (Date.parse(event.at) > now.getTime()) continue;
        changes.push({ entityKey: event.key, field: "status", oldValue: "scheduled", newValue: "ended", at: nowIso, reason, decision: "applied" });
        event.status = "ended";
        event.lastVerified = nowIso;
    }
    knowledge.changes.push(...changes);
    return changes;
}
