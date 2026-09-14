/**
 * V2 tracker run: adapter -> knowledge -> compatibility view.
 *
 *   load knowledge (store)
 *   run adapter          -> events for this topic (or a failure)
 *   upsert events        -> Change records only when something actually changed
 *   end past schedules   -> scheduled instants that have passed become "ended"
 *   save knowledge       -> only on adapter success
 *   derive view          -> fresh / stale (stored knowledge) / unavailable
 *
 * Failures never delete or rewrite stored knowledge.
 */
import { ProviderResult } from "../types";
import { Adapter } from "./adapter";
import { Change, Game, GameKnowledge, Topic } from "./domain";
import { adapterFor, findGame, findTopic } from "./games";
import { endPastScheduled, eventsForTopic, getSourceState, putSourceState, touchEvents, upsertEvent } from "./knowledge";
import { KnowledgeStore } from "./store";
import { deriveProviderResult, selectCurrentEvent, unavailableResult } from "./views";

export interface TrackerRunResult {
    result: ProviderResult;
    /** Knowledge after the run, or null when the store could not be read. */
    knowledge: GameKnowledge | null;
    /** Change records appended by this run. */
    changes: Change[];
    /** Events created by this run. */
    created: number;
    /** Set when the knowledge file could not be written; the result is still served from memory. */
    saveError?: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Persists knowledge without letting a write failure (read-only checkout, full
 * disk) discard a result that is already correct in memory. Returns the error
 * message so the orchestrator can surface it.
 */
function trySave(store: KnowledgeStore, knowledge: GameKnowledge): string | undefined {
    try {
        store.save(knowledge);
        return undefined;
    } catch (error) {
        const message = errorMessage(error);
        console.error(`✗ Knowledge for ${knowledge.game} could not be saved: ${message}`);
        return message;
    }
}

export async function runTracker(game: Game, topic: Topic, adapter: Adapter, store: KnowledgeStore, now: Date): Promise<TrackerRunResult> {
    let knowledge: GameKnowledge;
    try {
        knowledge = store.load(game.id);
    } catch (error) {
        // Corrupt or unreadable knowledge: report loudly, touch nothing.
        return { result: unavailableResult(topic, now, `Knowledge store error: ${errorMessage(error)}`), knowledge: null, changes: [], created: 0 };
    }

    let outcome;
    try {
        outcome = await adapter({ now, game, topic, getSourceState: (id) => getSourceState(knowledge, id) });
    } catch (error) {
        const reason = errorMessage(error);
        const result = deriveProviderResult(topic, knowledge, { now, outcome: { ok: false, reason } });
        return { result, knowledge, changes: [], created: 0 };
    }

    // Fetch bookkeeping is persisted even when the source failed, so streaks are visible.
    for (const state of outcome.sourceStates ?? []) putSourceState(knowledge, state);

    if (outcome.failure) {
        knowledge.updatedAt = now.toISOString();
        const saveError = trySave(store, knowledge);
        const result = deriveProviderResult(topic, knowledge, { now, outcome: { ok: false, reason: outcome.failure } });
        return { result, knowledge, changes: [], created: 0, saveError };
    }

    const changes: Change[] = [];
    let created = 0;
    for (const input of outcome.events) {
        const upsert = upsertEvent(knowledge, topic, input, now, `observed by ${topic.sourceId}`);
        if (upsert.created) created++;
        changes.push(...upsert.changes);
    }
    if (outcome.unchanged) {
        const current = selectCurrentEvent(eventsForTopic(knowledge, topic.type), now);
        if (current) touchEvents([current], now);
    }
    changes.push(...endPastScheduled(knowledge, topic, now, "scheduled instant has passed"));

    knowledge.updatedAt = now.toISOString();
    const saveError = trySave(store, knowledge);

    const result = deriveProviderResult(topic, knowledge, {
        now,
        outcome: { ok: true, httpStatus: outcome.fetch?.httpStatus, fetchMode: outcome.fetch?.mode }
    });
    return { result, knowledge, changes, created, saveError };
}

/** Entry point used by the orchestrator: resolves configuration by ids. */
export async function runV2Tracker(gameId: string, type: string, store: KnowledgeStore, now: Date = new Date()): Promise<TrackerRunResult> {
    const game = findGame(gameId);
    const topic = findTopic(game, type);
    return runTracker(game, topic, adapterFor(topic), store, now);
}
