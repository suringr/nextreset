/**
 * Adapter contract: how a topic obtains its events.
 *
 * An adapter observes or computes events for one topic and returns them
 * without keys; identity is assigned by the pipeline through identity.ts.
 * Failure is signalled by throwing; the pipeline then serves stored knowledge.
 */
import { Confidence } from "../types";
import type { AiGate } from "./cost/budget";
import { LearnInput } from "./discovery/learning";
import { Claim, DatePrecision, Document, EventStatus, Game, GameKnowledge, SourceState, Topic } from "./domain";
import { FailureKind } from "./reasons";

export interface EventInput {
    /** Raw identity; normalized into the key by the pipeline. */
    identity: string;
    label: string;
    status: EventStatus;
    at?: string;
    startAt?: string;
    endAt?: string;
    precision: DatePrecision;
    timezone?: string;
}

export interface AdapterContext {
    now: Date;
    game: Game;
    topic: Topic;
    /** Fetch state persisted for a source by a previous run, if any. */
    getSourceState: (sourceId: string) => SourceState | undefined;
    /** Stored knowledge, for adapters that consult events or learned sources. Read-only: the pipeline applies changes. */
    knowledge: GameKnowledge;
    /**
     * The run's AI budget gate. Adapters that need a model take their provider from it, so every call is
     * checked against the daily limits and recorded. Absent in standalone use (tests, tools).
     */
    ai?: AiGate;
}

/** What a run did with its documents, for cost reporting. */
export interface WorkStats {
    /** Documents found unchanged (HTTP 304 or the same text hash): no parsing, no model call. */
    unchanged: number;
    /** Documents or rules resolved by deterministic code (structured parse, recurring rule). */
    deterministic: number;
    /** Changed documents sent to the AI model. */
    sentToAi: number;
    /** Changed documents whose AI work the budget deferred. */
    deferred: number;
}

export interface AdapterOutcome {
    events: EventInput[];
    /** Transport metadata for the V1-compatible view (`http_status`, `fetch_mode`). */
    fetch?: {
        httpStatus?: number;
        mode?: "http" | "browser";
    };
    /**
     * The source answered but its content is unchanged since the last usable
     * fetch (HTTP 304 or identical normalized text): nothing new to upsert, the
     * current event is simply re-verified.
     */
    unchanged?: boolean;
    /**
     * The source could not be used this run (fetch failed, content unusable).
     * The pipeline serves stored knowledge as stale, exactly like a thrown error,
     * but still persists `sourceStates` so failure streaks are recorded.
     */
    failure?: string;
    /**
     * What kind of failure it was, in the public vocabulary (reasons.ts). The published `reason` is
     * derived from this alone; `failure` stays internal (logs, run report, step summary).
     */
    failureKind?: FailureKind;
    /** Updated fetch bookkeeping to persist. */
    sourceStates?: SourceState[];
    /** Evidence to persist with the events: the fetched document(s) and the claims behind each fact. */
    documents?: Document[];
    claims?: Claim[];
    /** Discovery learning to apply: pages that produced accepted knowledge, and known pages that failed this run. */
    learned?: { successes: LearnInput[]; failures: string[] };
    /** Confidence computed for this run's answer; overrides the topic's static label in the view. */
    confidence?: Confidence;
    /**
     * AI work the budget did not allow. Always paired with `failure`: stored knowledge is served, the
     * deferred document is not marked as seen, and a later run retries.
     */
    deferred?: { reason: "deferred_due_to_budget"; detail: string };
    /** When this run's discovery searched (see discovery/cadence.ts); persisted as the topic's last discovery. */
    discoveryRanAt?: string;
    /** Documents skipped, parsed, sent to AI or deferred this run. */
    work?: WorkStats;
    /**
     * The identity the source names as current (for example a manifest's latest release). Published events of the
     * topic dated later than it are held, so a withdrawn release stops being published, and the named event is
     * published again if it was held.
     */
    currentIdentity?: string;
    /**
     * The events returned include every scheduled event the source currently lists for the topic. Stored scheduled
     * events of the topic that are still upcoming but no longer listed are held (a corrected, postponed or withdrawn
     * date), and a held event that is listed again is published again.
     */
    listsAllScheduled?: boolean;
    /** Diagnostics for logs and reports (discovery queries, candidates, AI usage). Never persisted. */
    report?: Record<string, unknown>;
}

export type Adapter = (ctx: AdapterContext) => Promise<AdapterOutcome>;
