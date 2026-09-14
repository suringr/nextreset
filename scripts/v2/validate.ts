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
    requireIso(event, "endAt", path, true);
    requireOneOf(event, "precision", path, PRECISIONS);
    requireString(event, "timezone", path, true);
    requireIso(event, "firstSeen", path);
    requireIso(event, "lastVerified", path);
    requireOneOf(event, "publishState", path, PUBLISH_STATES);

    if (kind === "period") {
        if (!startAt) fail(`${path}.startAt`, "is required for period events");
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
    requireIso(claim, "extractedAt", path);
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

    return root as unknown as GameKnowledge;
}
