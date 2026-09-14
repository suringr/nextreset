/**
 * Adapter contract: how a topic obtains its events.
 *
 * An adapter observes or computes events for one topic and returns them
 * without keys; identity is assigned by the pipeline through identity.ts.
 * Failure is signalled by throwing; the pipeline then serves stored knowledge.
 */
import { DatePrecision, EventStatus, Game, SourceState, Topic } from "./domain";

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
}

export type Adapter = (ctx: AdapterContext) => Promise<AdapterOutcome>;
