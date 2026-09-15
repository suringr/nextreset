/**
 * Adapter contract: how a topic obtains its events.
 *
 * An adapter observes or computes events for one topic and returns them
 * without keys; identity is assigned by the pipeline through identity.ts.
 * Failure is signalled by throwing; the pipeline then serves stored knowledge.
 */
import { Confidence } from "../types";
import { LearnInput } from "./discovery/learning";
import { Claim, DatePrecision, Document, EventStatus, Game, GameKnowledge, SourceState, Topic } from "./domain";

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
    /** Updated fetch bookkeeping to persist. */
    sourceStates?: SourceState[];
    /** Evidence to persist with the events: the fetched document(s) and the claims behind each fact. */
    documents?: Document[];
    claims?: Claim[];
    /** Discovery learning to apply: pages that produced accepted knowledge, and known pages that failed this run. */
    learned?: { successes: LearnInput[]; failures: string[] };
    /** Confidence computed for this run's answer; overrides the topic's static label in the view. */
    confidence?: Confidence;
    /** Diagnostics for logs and reports (discovery queries, candidates, AI usage). Never persisted. */
    report?: Record<string, unknown>;
}

export type Adapter = (ctx: AdapterContext) => Promise<AdapterOutcome>;
