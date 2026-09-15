/**
 * Schema validation at the storage boundary.
 *
 * Hand-written on purpose: the schema is small, the repository has no
 * validation dependency, and every error names the offending path.
 */
import {
    ChangeDecision,
    DatePrecision,
    EventStatus,
    GameKnowledge,
    KNOWLEDGE_SCHEMA_VERSION,
    PublishState,
    TopicKind
} from "./domain";
import { isEventKey, parseEventKey } from "./identity";

export class KnowledgeValidationError extends Error {
    constructor(message: string, public readonly path: string) {
        super(`${path}: ${message}`);
        this.name = "KnowledgeValidationError";
    }
}

const TOPIC_KINDS: readonly TopicKind[] = ["version", "period", "occurrence", "recurring"];
const EVENT_STATUSES: readonly EventStatus[] = ["scheduled", "ended", "observed"];
const PRECISIONS: readonly DatePrecision[] = ["exact", "day"];
const PUBLISH_STATES: readonly PublishState[] = ["published", "held"];
const DECISIONS: readonly ChangeDecision[] = ["applied", "held", "rejected", "override"];
const CLAIM_FIELDS = ["at", "startAt", "endAt", "label", "status"] as const;
const CLAIM_METHODS = ["deterministic", "ai"] as const;
const FETCH_MODES = ["http", "browser"] as const;
const CONFIDENCES = ["high", "medium", "low", "none"] as const;
const DISCOVERY_VIAS = ["config", "learned", "sitemap", "seed", "secondary-link", "web"] as const;

type Rec = Record<string, unknown>;

function fail(path: string, message: string): never {
    throw new KnowledgeValidationError(message, path);
}

function isRecord(value: unknown): value is Rec {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Rec {
    if (!isRecord(value)) fail(path, "must be an object");
    return value;
}

function requireArray(obj: Rec, key: string, path: string): unknown[] {
    const value = obj[key];
    if (!Array.isArray(value)) fail(`${path}.${key}`, "must be an array");
    return value;
}

function requireString(obj: Rec, key: string, path: string, optional = false): string | undefined {
    const value = obj[key];
    if (value === undefined) {
        if (optional) return undefined;
        fail(`${path}.${key}`, "is required");
    }
    if (typeof value !== "string" || value.length === 0) fail(`${path}.${key}`, "must be a non-empty string");
    return value;
}

function requireIso(obj: Rec, key: string, path: string, optional = false): string | undefined {
    const value = requireString(obj, key, path, optional);
    if (value === undefined) return undefined;
    if (isNaN(Date.parse(value))) fail(`${path}.${key}`, `must be an ISO 8601 date, got ${JSON.stringify(value)}`);
    return value;
}

function requireOneOf<T extends string>(obj: Rec, key: string, path: string, allowed: readonly T[], optional = false): T | undefined {
    const value = obj[key];
    if (value === undefined) {
        if (optional) return undefined;
        fail(`${path}.${key}`, "is required");
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
        fail(`${path}.${key}`, `must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
    }
    return value as T;
}

function requireStringOrNull(obj: Rec, key: string, path: string): void {
    const value = obj[key];
    if (value !== null && typeof value !== "string") fail(`${path}.${key}`, "must be a string or null");
}

function validateEvent(value: unknown, path: string, gameId: string): void {
    const event = requireRecord(value, path);
    const key = event.key;
    if (!isEventKey(key)) fail(`${path}.key`, `must be an event key like game/topic/identity, got ${JSON.stringify(key)}`);
    const parsed = parseEventKey(key);
    if (parsed.game !== gameId) fail(`${path}.key`, `belongs to game ${parsed.game}, file is for ${gameId}`);
    if (requireString(event, "game", path) !== gameId) fail(`${path}.game`, `must equal ${gameId}`);
    if (requireString(event, "topic", path) !== parsed.topic) fail(`${path}.topic`, `must equal the key's topic ${parsed.topic}`);
    const kind = requireOneOf(event, "kind", path, TOPIC_KINDS)!;
    requireString(event, "label", path);
    requireOneOf(event, "status", path, EVENT_STATUSES);
    const at = requireIso(event, "at", path, true);
    const startAt = requireIso(event, "startAt", path, true);
    const endAt = requireIso(event, "endAt", path, true);
    requireOneOf(event, "precision", path, PRECISIONS);
    requireString(event, "timezone", path, true);
    requireIso(event, "firstSeen", path);
    requireIso(event, "lastVerified", path);
    requireOneOf(event, "publishState", path, PUBLISH_STATES);

    if (kind === "period") {
        // A period needs a start. Its end may be unknown (open-ended) until the
        // publisher announces it, but a known end can never precede the start.
        if (!startAt) fail(`${path}.startAt`, "is required for period events");
        if (endAt && Date.parse(endAt) < Date.parse(startAt)) fail(`${path}.endAt`, `must not be before startAt (${startAt})`);
    } else if (!at) {
        fail(`${path}.at`, `is required for ${kind} events`);
    }
}

function validateChange(value: unknown, path: string): void {
    const change = requireRecord(value, path);
    requireString(change, "entityKey", path);
    requireString(change, "field", path);
    requireStringOrNull(change, "oldValue", path);
    requireStringOrNull(change, "newValue", path);
    requireIso(change, "at", path);
    requireString(change, "reason", path);
    requireOneOf(change, "decision", path, DECISIONS);
}

function validateOverride(value: unknown, path: string): void {
    const override = requireRecord(value, path);
    requireString(override, "eventKey", path);
    requireString(override, "field", path);
    requireString(override, "value", path);
    requireString(override, "reason", path);
    requireIso(override, "setAt", path);
    requireIso(override, "expiresAt", path, true);
}

function validateDocument(value: unknown, path: string): void {
    const doc = requireRecord(value, path);
    requireString(doc, "id", path);
    requireString(doc, "url", path);
    requireString(doc, "sourceId", path);
    requireIso(doc, "fetchedAt", path);
    requireString(doc, "title", path, true);
    requireOneOf(doc, "fetchMode", path, FETCH_MODES, true);
    requireOneOf(doc, "confidence", path, CONFIDENCES, true);
}

function validateSourceState(value: unknown, path: string): void {
    const state = requireRecord(value, path);
    requireString(state, "id", path);
    requireString(state, "url", path);
    requireString(state, "etag", path, true);
    requireString(state, "lastModified", path, true);
    requireString(state, "textHash", path, true);
    requireIso(state, "lastFetchedAt", path, true);
    requireIso(state, "lastUsableAt", path, true);
    requireString(state, "lastVerdict", path, true);
    requireOneOf(state, "lastMode", path, FETCH_MODES, true);
    if (typeof state.consecutiveFailures !== "number" || state.consecutiveFailures < 0 || !Number.isInteger(state.consecutiveFailures)) {
        fail(`${path}.consecutiveFailures`, "must be a non-negative integer");
    }
}

function validateDiscoveredSource(value: unknown, path: string): void {
    const source = requireRecord(value, path);
    requireString(source, "id", path);
    requireString(source, "url", path);
    requireString(source, "topic", path);
    // The store never holds a secondary page as a learned source.
    requireOneOf(source, "tier", path, ["official"] as const);
    requireOneOf(source, "via", path, DISCOVERY_VIAS);
    requireString(source, "query", path, true);
    requireString(source, "title", path, true);
    requireIso(source, "discoveredAt", path);
    requireIso(source, "lastSuccessAt", path);
    requireIso(source, "lastFailureAt", path, true);
    for (const key of ["successes", "failures"]) {
        const n = source[key];
        if (typeof n !== "number" || n < 0 || !Number.isInteger(n)) fail(`${path}.${key}`, "must be a non-negative integer");
    }
}

function validateClaim(value: unknown, path: string): void {
    const claim = requireRecord(value, path);
    requireString(claim, "id", path);
    requireString(claim, "documentId", path);
    if (!isEventKey(claim.eventKey)) fail(`${path}.eventKey`, "must be an event key");
    requireOneOf(claim, "field", path, CLAIM_FIELDS);
    requireString(claim, "value", path);
    requireOneOf(claim, "method", path, CLAIM_METHODS);
    requireString(claim, "quote", path, true);
    const link = requireString(claim, "linkUrl", path, true);
    if (link !== undefined && !/^https:\/\//i.test(link)) fail(`${path}.linkUrl`, "must be an https URL");
    requireIso(claim, "extractedAt", path);
}

const DEFERRAL_REASONS = ["deferred_due_to_budget"] as const;

function validateTopicState(value: unknown, path: string): void {
    const t = requireRecord(value, path);
    requireString(t, "topic", path);
    requireIso(t, "lastDiscoveryAt", path, true);
    if (t.deferred !== undefined) {
        const d = requireRecord(t.deferred, `${path}.deferred`);
        requireOneOf(d, "reason", `${path}.deferred`, DEFERRAL_REASONS);
        requireString(d, "detail", `${path}.deferred`);
        requireIso(d, "at", `${path}.deferred`);
    }
}

/**
 * Validates an arbitrary parsed value as a GameKnowledge document.
 * Returns the same object, typed, or throws KnowledgeValidationError naming the path.
 */
export function validateGameKnowledge(value: unknown, where = "knowledge"): GameKnowledge {
    const root = requireRecord(value, where);

    if (root.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
        fail(`${where}.schemaVersion`, `must be ${KNOWLEDGE_SCHEMA_VERSION}, got ${JSON.stringify(root.schemaVersion)}`);
    }
    const gameId = requireString(root, "game", where)!;
    requireIso(root, "updatedAt", where);

    const events = requireArray(root, "events", where);
    const seen = new Set<string>();
    events.forEach((event, i) => {
        const path = `${where}.events[${i}]`;
        validateEvent(event, path, gameId);
        const key = (event as Rec).key as string;
        if (seen.has(key)) fail(`${path}.key`, `duplicate event key ${key}`);
        seen.add(key);
    });

    requireArray(root, "changes", where).forEach((c, i) => validateChange(c, `${where}.changes[${i}]`));
    requireArray(root, "overrides", where).forEach((o, i) => validateOverride(o, `${where}.overrides[${i}]`));
    requireArray(root, "documents", where).forEach((d, i) => validateDocument(d, `${where}.documents[${i}]`));
    requireArray(root, "claims", where).forEach((c, i) => validateClaim(c, `${where}.claims[${i}]`));

    // `sources` arrived after the first schema-1 files were written; treat absence as empty.
    if (root.sources === undefined) root.sources = [];
    const sourceIds = new Set<string>();
    requireArray(root, "sources", where).forEach((s, i) => {
        const path = `${where}.sources[${i}]`;
        validateSourceState(s, path);
        const id = (s as Rec).id as string;
        if (sourceIds.has(id)) fail(`${path}.id`, `duplicate source id ${id}`);
        sourceIds.add(id);
    });

    // `discovered` arrived with web discovery; treat absence as empty.
    if (root.discovered === undefined) root.discovered = [];
    const discoveredIds = new Set<string>();
    requireArray(root, "discovered", where).forEach((d, i) => {
        const path = `${where}.discovered[${i}]`;
        validateDiscoveredSource(d, path);
        const id = (d as Rec).id as string;
        if (discoveredIds.has(id)) fail(`${path}.id`, `duplicate discovered source id ${id}`);
        discoveredIds.add(id);
    });

    // `topicStates` arrived with the AI cost guardrails; treat absence as empty.
    if (root.topicStates === undefined) root.topicStates = [];
    const topicStateIds = new Set<string>();
    requireArray(root, "topicStates", where).forEach((t, i) => {
        const path = `${where}.topicStates[${i}]`;
        validateTopicState(t, path);
        const topic = (t as Rec).topic as string;
        if (topicStateIds.has(topic)) fail(`${path}.topic`, `duplicate topic state ${topic}`);
        topicStateIds.add(topic);
    });

    return root as unknown as GameKnowledge;
}
