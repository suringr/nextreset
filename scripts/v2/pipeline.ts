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
import { Adapter, AdapterOutcome, WorkStats } from "./adapter";
import { AiGate } from "./cost/budget";
import { recordSourceFailure, recordSourceSuccess } from "./discovery/learning";
import { Change, Game, GameKnowledge, Topic } from "./domain";
import { adapterFor, findGame, findTopic } from "./games";
import { applyCurrentPointer, endPastScheduled, eventsForTopic, getSourceState, putSourceState, recordTopicRun, touchEvents, upsertEvent } from "./knowledge";
import { KnowledgeStore } from "./store";
import { KnowledgeValidationError } from "./validate";
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
    /** Adapter diagnostics for this run (see AdapterOutcome.report). */
    report?: Record<string, unknown>;
    /** Documents this run skipped, parsed, sent to AI or deferred (see AdapterOutcome.work). */
    work?: WorkStats;
    /** Set when AI work was deferred by the budget; stored knowledge was served instead. */
    deferred?: AdapterOutcome["deferred"];
}

export interface RunOptions {
    /** The run's AI budget gate, passed to adapters in their context. */
    ai?: AiGate;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Persists knowledge without letting an I/O failure (read-only checkout, full
 * disk) discard a result that is already correct in memory. Returns the error
 * message so the orchestrator can surface it. A schema violation is not an I/O
 * failure: invalid knowledge must never be published, so it propagates and the
 * orchestrator falls back exactly as for a crashed provider.
 */
function trySave(store: KnowledgeStore, knowledge: GameKnowledge): string | undefined {
    try {
        store.save(knowledge);
        return undefined;
    } catch (error) {
        if (error instanceof KnowledgeValidationError) throw error;
        const message = errorMessage(error);
        console.error(`✗ Knowledge for ${knowledge.game} could not be saved: ${message}`);
        return message;
    }
}

export async function runTracker(game: Game, topic: Topic, adapter: Adapter, store: KnowledgeStore, now: Date, options: RunOptions = {}): Promise<TrackerRunResult> {
    let knowledge: GameKnowledge;
    try {
        knowledge = store.load(game.id);
    } catch (error) {
        // Corrupt or unreadable knowledge: report loudly, touch nothing.
        return { result: unavailableResult(topic, now, `Knowledge store error: ${errorMessage(error)}`), knowledge: null, changes: [], created: 0 };
    }

    let outcome;
    try {
        outcome = await adapter({ now, game, topic, knowledge, getSourceState: (id) => getSourceState(knowledge, id), ai: options.ai });
    } catch (error) {
        const reason = errorMessage(error);
        const result = deriveProviderResult(topic, knowledge, { now, outcome: { ok: false, reason } });
        return { result, knowledge, changes: [], created: 0 };
    }

    // Fetch bookkeeping is persisted even when the source failed, so streaks are visible.
    for (const state of outcome.sourceStates ?? []) putSourceState(knowledge, state);

    // Learning bookkeeping (failures of learned pages) is persisted even on a failed run.
    for (const url of outcome.learned?.failures ?? []) recordSourceFailure(knowledge, topic.type, url, now);

    // Discovery cadence and budget deferral are persisted whatever the outcome.
    recordTopicRun(knowledge, topic.type, { discoveryRanAt: outcome.discoveryRanAt, deferred: outcome.deferred }, now);

    if (outcome.failure) {
        knowledge.updatedAt = now.toISOString();
        const saveError = trySave(store, knowledge);
        const result = deriveProviderResult(topic, knowledge, { now, outcome: { ok: false, reason: outcome.failure } });
        return { result, knowledge, changes: [], created: 0, saveError, report: outcome.report, work: outcome.work, deferred: outcome.deferred };
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
    // A source that names its current event retires later-dated events it no longer vouches for (a withdrawn release).
    if (outcome.currentIdentity) {
        changes.push(...applyCurrentPointer(knowledge, topic, outcome.currentIdentity, now, `${topic.sourceId} names ${outcome.currentIdentity} as current`));
    }
    changes.push(...endPastScheduled(knowledge, topic, now, "scheduled instant has passed"));

    // Evidence: documents and claims are appended once (ids are content-derived), never rewritten.
    for (const doc of outcome.documents ?? []) {
        if (!knowledge.documents.some(d => d.id === doc.id)) knowledge.documents.push(doc);
    }
    for (const claim of outcome.claims ?? []) {
        if (!knowledge.claims.some(c => c.id === claim.id)) knowledge.claims.push(claim);
    }
    for (const learned of outcome.learned?.successes ?? []) recordSourceSuccess(knowledge, topic.type, learned, now);

    knowledge.updatedAt = now.toISOString();
    const saveError = trySave(store, knowledge);

    const result = deriveProviderResult(topic, knowledge, {
        now,
        outcome: { ok: true, httpStatus: outcome.fetch?.httpStatus, fetchMode: outcome.fetch?.mode },
        confidence: outcome.confidence
    });
    return { result, knowledge, changes, created, saveError, report: outcome.report, work: outcome.work };
}

/** Entry point used by the orchestrator: resolves configuration by ids. */
export async function runV2Tracker(gameId: string, type: string, store: KnowledgeStore, now: Date = new Date(), options: RunOptions = {}): Promise<TrackerRunResult> {
    const game = findGame(gameId);
    const topic = findTopic(game, type);
    return runTracker(game, topic, adapterFor(topic), store, now, options);
}
