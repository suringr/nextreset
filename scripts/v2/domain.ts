/**
 * NextReset V2 domain model (PR #2: deliberately minimal).
 *
 * One JSON file per game (see store.ts) holds everything the pipeline knows about
 * that game: Events (the facts we publish), the append-only Change log, operator
 * Overrides, and the evidence tables (Documents, Claims) that evidence-based
 * extraction will fill in a later PR. The adapters in this PR do not fabricate
 * provenance; their Document/Claim arrays stay empty.
 *
 * Fields exist because a current caller reads or writes them. The only forward
 * looking pieces are `startAt`/`endAt` (a `period` kind without bounds would be
 * incoherent) and the Document/Claim shapes, both part of the approved model.
 */
import { Confidence } from "../types";

/** How a topic's events behave. */
export type TopicKind = "version" | "period" | "occurrence" | "recurring";

/** Event lifecycle. Later kinds (for example released versions) extend this union. */
export type EventStatus = "scheduled" | "ended" | "observed";

/** Whether the stored instant is exact or only known to the day. */
export type DatePrecision = "exact" | "day";

export type PublishState = "published" | "held";

/** Metadata the V1-compatible view needs, carried per topic so the view code stays generic. */
export interface TopicView {
    /** V1 `title` (also the page heading). */
    title: string;
    /** V1 `source_url`: the attribution link shown to visitors. */
    sourceUrl: string;
    /** V1 static confidence label. Computed scoring is a later PR. */
    confidence: Confidence;
    /** V1 `notes`. May contain `{label}`, replaced with the current event's label. */
    notes?: string;
}

/** How a topic finds its documents when no known source answers (see scripts/v2/discovery). */
export interface TopicDiscovery {
    /** Query templates with {game}, {latest} (latest known label) and {next} (the version after it). */
    queries?: string[];
    /** Phrases preferred in a candidate's title or URL, e.g. ["patch schedule"]. */
    terms?: string[];
    /**
     * When known sources count as answering the topic's question:
     * "future-scheduled" (default for version/occurrence): a scheduled event in the future is known;
     * "usable-source" (default for period/recurring): at least one known source was usable this run.
     */
    answeredWhen?: "future-scheduled" | "usable-source";
}

export interface Topic {
    /** Game id (equals Game.id and the V1 `game` field). */
    game: string;
    /** Topic slug; equals the V1 `type` and the JSON filename segment. */
    type: string;
    kind: TopicKind;
    /** Source this topic's adapter consults (see Game.sources). */
    sourceId: string;
    view: TopicView;
    discovery?: TopicDiscovery;
}

export type SourceKind = "json" | "rule" | "html" | "rss";

export interface Source {
    id: string;
    /** Fetch URL, or a descriptive URL for rule-based sources. */
    url: string;
    kind: SourceKind;
}

/** Where a game's official evidence lives and how to search it without an exact URL. */
export interface DiscoveryConfig {
    /** Domains (subdomains included) whose pages are official evidence. Everything else is secondary. */
    officialDomains: string[];
    /** Hosts whose XML sitemaps are searched. */
    sitemapHosts?: string[];
    /** Official listing/hub pages whose links are searched. */
    seeds?: string[];
}

export interface Game {
    /** Stable id; equals the V1 `game` field and the JSON filename segment. */
    id: string;
    name: string;
    /** URL segment (today identical to id). */
    slug: string;
    sources: Source[];
    topics: Topic[];
    discovery?: DiscoveryConfig;
}

export interface Event {
    /** Deterministic key `<game>/<topic>/<identity>`; see identity.ts. */
    key: string;
    game: string;
    topic: string;
    kind: TopicKind;
    label: string;
    status: EventStatus;
    /** Instant of the event (occurrence, recurring, version). ISO 8601 UTC. */
    at?: string;
    /** Period start (period kind). ISO 8601 UTC. */
    startAt?: string;
    /**
     * Period end (period kind). ISO 8601 UTC. Absent while the publisher has not
     * announced it: seasons are routinely announced with a start date only, and the
     * end is filled in by a later observation.
     */
    endAt?: string;
    precision: DatePrecision;
    /** IANA zone the publisher stated the time in, when known. */
    timezone?: string;
    firstSeen: string;
    lastVerified: string;
    publishState: PublishState;
}

/** A fetched document (evidence container). Metadata only; raw HTML is never stored. */
export interface Document {
    /** sha256 of the extracted text. */
    id: string;
    url: string;
    sourceId: string;
    fetchedAt: string;
    title?: string;
    fetchMode?: "http" | "browser";
    /** Confidence computed when facts were extracted from this document (evidence-based topics). */
    confidence?: Confidence;
}

/** One extracted assertion about one event field, tied to the document it came from. */
export interface Claim {
    id: string;
    documentId: string;
    eventKey: string;
    field: "at" | "startAt" | "endAt" | "label" | "status";
    value: string;
    method: "deterministic" | "ai";
    /** Verbatim quote supporting the value (required for AI claims in later PRs). */
    quote?: string;
    extractedAt: string;
}

export type ChangeDecision = "applied" | "held" | "rejected" | "override";

/** Append-only audit record for a knowledge mutation. */
export interface Change {
    /** Event key the change applies to. */
    entityKey: string;
    /** Field changed, or "event" for creation of the whole event. */
    field: string;
    oldValue: string | null;
    newValue: string | null;
    at: string;
    reason: string;
    decision: ChangeDecision;
}

/** Operator-pinned value. Representation only in this PR; no workflow reads it yet. */
export interface Override {
    eventKey: string;
    field: string;
    value: string;
    reason: string;
    setAt: string;
    expiresAt?: string;
}

/**
 * Fetch bookkeeping for one source: conditional-request validators, the hash of
 * the last usable normalized text, and the failure streak. Written by the smart
 * fetch layer (scripts/v2/fetch) and read back on the next run.
 */
export interface SourceState {
    id: string;
    url: string;
    etag?: string;
    lastModified?: string;
    textHash?: string;
    lastFetchedAt?: string;
    lastUsableAt?: string;
    lastVerdict?: string;
    lastMode?: "http" | "browser";
    consecutiveFailures: number;
}

/** How a discovered page was found. */
export type DiscoveryVia = "config" | "learned" | "sitemap" | "seed" | "secondary-link" | "web";

/**
 * An official page that discovery found and that produced accepted knowledge.
 * Learned sources are consulted before searching on later runs. Only official
 * pages are ever stored here; secondary pages can lead to one but are never
 * learned as evidence.
 */
export interface DiscoveredSource {
    /** `<topic>:<sha256(url) prefix>`. */
    id: string;
    url: string;
    topic: string;
    tier: "official";
    via: DiscoveryVia;
    /** Query that found it, when search did. */
    query?: string;
    title?: string;
    discoveredAt: string;
    lastSuccessAt: string;
    lastFailureAt?: string;
    successes: number;
    failures: number;
}

export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** Everything stored for one game: `knowledge/games/<game>.json`. */
export interface GameKnowledge {
    schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
    game: string;
    updatedAt: string;
    events: Event[];
    changes: Change[];
    overrides: Override[];
    documents: Document[];
    claims: Claim[];
    /** Per-source fetch state. Files written before this field existed load as []. */
    sources: SourceState[];
    /** Official pages learned by discovery. Files written before this field existed load as []. */
    discovered: DiscoveredSource[];
}

export function emptyKnowledge(gameId: string, now: Date = new Date()): GameKnowledge {
    return {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        game: gameId,
        updatedAt: now.toISOString(),
        events: [],
        changes: [],
        overrides: [],
        documents: [],
        claims: [],
        sources: [],
        discovered: []
    };
}
