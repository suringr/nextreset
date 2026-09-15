/**
 * KnowledgeStore: persistence boundary for GameKnowledge.
 *
 * The interface is intentionally tiny (load / save). Callers mutate the loaded
 * document through the pure helpers in knowledge.ts and save it back, so the
 * pipeline never sees files, paths or git.
 *
 * JsonKnowledgeStore keeps one human-readable file per game at
 * `<root>/games/<game>.json`. In CI `<root>` is a git worktree of the
 * `knowledge` branch (see .github/scripts/knowledge-*.sh); locally it is a
 * plain, gitignored directory created on demand.
 */
import * as fs from "fs";
import * as path from "path";
import { Change, Claim, DiscoveredSource, Document, Event, GameKnowledge, Override, SourceState, emptyKnowledge } from "./domain";
import { KnowledgeValidationError, validateGameKnowledge } from "./validate";

export class KnowledgeStoreError extends Error {
    constructor(message: string, public readonly file: string, public readonly cause?: unknown) {
        super(`${file}: ${message}`);
        this.name = "KnowledgeStoreError";
    }
}

export interface KnowledgeStore {
    /**
     * Returns the stored knowledge for a game, or an empty document when nothing
     * has been stored yet. Throws KnowledgeStoreError when a file exists but is
     * not valid JSON or fails schema validation; corrupt files are never
     * silently replaced.
     */
    load(gameId: string): GameKnowledge;

    /**
     * Validates and writes. Serialization is canonical (fixed field order,
     * events sorted by key, 2-space JSON, trailing newline), so identical
     * knowledge always produces identical bytes.
     */
    save(knowledge: GameKnowledge): void;

    /** Human-readable location of a game's knowledge, for logs. */
    describe(gameId: string): string;
}

export const DEFAULT_KNOWLEDGE_DIR = path.resolve(__dirname, "..", "..", "knowledge");

const GAME_ID = /^[a-z0-9][a-z0-9._-]*$/;

export class JsonKnowledgeStore implements KnowledgeStore {
    constructor(public readonly rootDir: string = DEFAULT_KNOWLEDGE_DIR) { }

    filePath(gameId: string): string {
        if (!GAME_ID.test(gameId)) throw new KnowledgeStoreError(`invalid game id ${JSON.stringify(gameId)}`, this.rootDir);
        return path.join(this.rootDir, "games", `${gameId}.json`);
    }

    describe(gameId: string): string {
        return this.filePath(gameId);
    }

    load(gameId: string): GameKnowledge {
        const file = this.filePath(gameId);
        if (!fs.existsSync(file)) return emptyKnowledge(gameId);

        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch (error) {
            throw new KnowledgeStoreError(`cannot read: ${(error as Error).message}`, file, error);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new KnowledgeStoreError(`not valid JSON (${(error as Error).message})`, file, error);
        }

        try {
            const knowledge = validateGameKnowledge(parsed, `games/${gameId}.json`);
            if (knowledge.game !== gameId) {
                throw new KnowledgeValidationError(`file is for game ${knowledge.game}`, `games/${gameId}.json.game`);
            }
            return knowledge;
        } catch (error) {
            if (error instanceof KnowledgeValidationError) throw new KnowledgeStoreError(`schema violation: ${error.message}`, file, error);
            throw error;
        }
    }

    save(knowledge: GameKnowledge): void {
        validateGameKnowledge(knowledge, `games/${knowledge.game}.json`);
        const file = this.filePath(knowledge.game);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, serializeKnowledge(knowledge), "utf8");
        fs.renameSync(tmp, file);
    }
}

/** Rebuilds the document with a fixed key order and events sorted by key. Pure. */
export function canonicalizeKnowledge(k: GameKnowledge): GameKnowledge {
    const events = [...k.events]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(canonicalEvent);
    return {
        schemaVersion: k.schemaVersion,
        game: k.game,
        updatedAt: k.updatedAt,
        events,
        changes: k.changes.map(canonicalChange),
        overrides: k.overrides.map(canonicalOverride),
        documents: k.documents.map(canonicalDocument),
        claims: k.claims.map(canonicalClaim),
        sources: [...(k.sources ?? [])]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map(canonicalSourceState),
        discovered: [...(k.discovered ?? [])]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map(canonicalDiscoveredSource)
    };
}

function canonicalDiscoveredSource(d: DiscoveredSource): DiscoveredSource {
    return dropUndefined({
        id: d.id,
        url: d.url,
        topic: d.topic,
        tier: d.tier,
        via: d.via,
        query: d.query,
        title: d.title,
        discoveredAt: d.discoveredAt,
        lastSuccessAt: d.lastSuccessAt,
        lastFailureAt: d.lastFailureAt,
        successes: d.successes,
        failures: d.failures
    });
}

function canonicalSourceState(s: SourceState): SourceState {
    return dropUndefined({
        id: s.id,
        url: s.url,
        etag: s.etag,
        lastModified: s.lastModified,
        textHash: s.textHash,
        lastFetchedAt: s.lastFetchedAt,
        lastUsableAt: s.lastUsableAt,
        lastVerdict: s.lastVerdict,
        lastMode: s.lastMode,
        consecutiveFailures: s.consecutiveFailures
    });
}

export function serializeKnowledge(k: GameKnowledge): string {
    return JSON.stringify(canonicalizeKnowledge(k), null, 2) + "\n";
}

function dropUndefined<T extends object>(obj: T): T {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) out[key] = value;
    }
    return out as T;
}

function canonicalEvent(e: Event): Event {
    return dropUndefined({
        key: e.key,
        game: e.game,
        topic: e.topic,
        kind: e.kind,
        label: e.label,
        status: e.status,
        at: e.at,
        startAt: e.startAt,
        endAt: e.endAt,
        precision: e.precision,
        timezone: e.timezone,
        firstSeen: e.firstSeen,
        lastVerified: e.lastVerified,
        publishState: e.publishState
    });
}

function canonicalChange(c: Change): Change {
    return {
        entityKey: c.entityKey,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        at: c.at,
        reason: c.reason,
        decision: c.decision
    };
}

function canonicalOverride(o: Override): Override {
    return dropUndefined({
        eventKey: o.eventKey,
        field: o.field,
        value: o.value,
        reason: o.reason,
        setAt: o.setAt,
        expiresAt: o.expiresAt
    });
}

function canonicalDocument(d: Document): Document {
    return dropUndefined({
        id: d.id,
        url: d.url,
        sourceId: d.sourceId,
        fetchedAt: d.fetchedAt,
        title: d.title,
        fetchMode: d.fetchMode,
        confidence: d.confidence
    });
}

function canonicalClaim(c: Claim): Claim {
    return dropUndefined({
        id: c.id,
        documentId: c.documentId,
        eventKey: c.eventKey,
        field: c.field,
        value: c.value,
        method: c.method,
        quote: c.quote,
        extractedAt: c.extractedAt
    });
}
