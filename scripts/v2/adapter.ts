/**
 * Adapter contract: how a topic obtains its events.
 *
 * An adapter observes or computes events for one topic and returns them
 * without keys; identity is assigned by the pipeline through identity.ts.
 * Failure is signalled by throwing; the pipeline then serves stored knowledge.
 */
import { DatePrecision, EventStatus, Game, Topic } from "./domain";

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
}

export interface AdapterOutcome {
    events: EventInput[];
    /** Transport metadata for the V1-compatible view (`http_status`, `fetch_mode`). */
    fetch?: {
        httpStatus?: number;
        mode?: "http" | "browser";
    };
}

export type Adapter = (ctx: AdapterContext) => Promise<AdapterOutcome>;
