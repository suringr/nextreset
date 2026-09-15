/**
 * AI-assisted extraction with deterministic grounding.
 *
 *   classifyDocument  -> is this document about the topic, and what kind is it?
 *   extractFacts      -> items (version / period / occurrence) with date fields,
 *                        each field carrying the verbatim quote that states it
 *   groundExtraction  -> deterministic checks: the item's identity occurs in the
 *                        document; the quote occurs in the document and names the
 *                        item; the quote states the claimed day/month(/year); a
 *                        claimed clock time and timezone are stated too, or the
 *                        fact is downgraded to day precision. Anything else is
 *                        rejected with a reason.
 *
 * The model never sees a URL it could echo as evidence, never assigns confidence,
 * and never decides what gets published.
 */
import { normalizeIdentity } from "../identity";
import { NormalizedDate, normalizeDateFact, parseDateValue, quoteMentionsDate, quoteMentionsTime, timezoneMentioned } from "./dates";
import { AiProvider, AiUsage } from "./provider";

export interface AiDocument {
    url: string;
    title?: string;
    /** Normalized visible text (see fetch/text.ts). */
    text: string;
}

export interface ExtractionTopic {
    game: string;
    gameName: string;
    /** Topic slug, e.g. "next-patch". */
    type: string;
    /** One or two sentences describing what facts matter for this topic. */
    description: string;
}

export type DocType = "patch-notes" | "patch-schedule" | "season" | "banner" | "maintenance" | "release" | "news" | "unrelated";
const DOC_TYPES: DocType[] = ["patch-notes", "patch-schedule", "season", "banner", "maintenance", "release", "news", "unrelated"];

export interface Classification {
    relevant: boolean;
    docType: DocType;
    summary: string;
    reason: string;
}

export const CLASSIFY_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        relevant: { type: "boolean", description: "True only if the document states facts useful for the topic." },
        docType: { type: "string", enum: DOC_TYPES },
        summary: { type: "string", description: "One sentence: what the document is." },
        reason: { type: "string", description: "One sentence: why it is or is not relevant to the topic." }
    },
    required: ["relevant", "docType", "summary", "reason"]
};

export type ItemKind = "version" | "period" | "occurrence";
export type ItemStatus = "scheduled" | "released" | "active" | "ended" | "announced" | "unknown";
export type DateField = "at" | "startAt" | "endAt";
const ITEM_KINDS: ItemKind[] = ["version", "period", "occurrence"];
const ITEM_STATUSES: ItemStatus[] = ["scheduled", "released", "active", "ended", "announced", "unknown"];
const DATE_FIELDS: DateField[] = ["at", "startAt", "endAt"];

export const EXTRACT_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ITEM_KINDS, description: "version = patch/update/hotfix; period = season/act/banner/version window; occurrence = maintenance, launch, one-off event" },
                    label: { type: "string", description: "Human label exactly as the document names it." },
                    identity: { type: "string", description: "What identifies this item, using words that appear in the document: a version number (26.19, Update 43.1), a season or version name (Season 05, Version 7.1), or for an occurrence the occurrence itself plus its date (Live maintenance PC March 11). For updates without a number, use the update name plus its date (Counter-Strike 2 Update September 10, 2026)." },
                    status: { type: "string", enum: ITEM_STATUSES },
                    fields: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                field: { type: "string", enum: DATE_FIELDS, description: "at = the instant of a version release or one-off event; startAt/endAt = bounds of a period or maintenance window" },
                                value: { type: "string", description: "ISO 8601: YYYY-MM-DD when only a date is stated, YYYY-MM-DDTHH:MM when a time is stated (local to the stated timezone)." },
                                timezone: { type: "string", description: "The timezone exactly as the document states it (e.g. PT, UTC, UTC+8, server time), or an empty string when none is stated." },
                                quote: { type: "string", description: "The exact fragment of the document that states this date, copied verbatim, including the item name (or version) and the date text (and the time, if you report one)." }
                            },
                            required: ["field", "value", "timezone", "quote"]
                        }
                    }
                },
                required: ["kind", "label", "identity", "status", "fields"]
            }
        }
    },
    required: ["items"]
};

export const MAX_DOCUMENT_CHARS = 24000;

const CLASSIFY_SYSTEM = `You classify a single web document for a video game tracking site.
Answer only from the document text. Decide whether the document states facts that are useful for the given topic (dates, versions, seasons, banners, maintenance windows) and what kind of document it is.
Output JSON matching the schema and nothing else.`;

const EXTRACT_SYSTEM = `You extract time-sensitive facts about a video game from a single document.
Rules:
- Use only information stated in the document. Never guess or invent a date. If the document states no date for an item, return the item with an empty fields array.
- For every date field, copy the exact fragment of the document that states it into "quote", verbatim. The quote must include the item's name or version and the date text, and the time when you report one. Do not paraphrase.
- "value" is ISO 8601: YYYY-MM-DD when only a date is stated; YYYY-MM-DDTHH:MM when a time is stated (local to the stated timezone). If the document states a day and month but no year, take the year from the document's own posting/update dates.
- "timezone" is the timezone phrase exactly as the document states it (e.g. "PT", "Pacific Time", "UTC", "UTC+8", "server time"); an empty string if none is stated.
- "identity" uses words that appear in the document: a version number (26.19, Update 43.1), a season/version name (Season 05, Version 7.1), or for an occurrence the occurrence itself plus its date (Live maintenance PC March 11), never the version it belongs to. For updates without a number, use the update name plus its date.
- For patch notes or update pages, the date the notes are dated or published is the version's "at" unless a different release date is stated.
- "status": "released" if the document indicates the item is out or live as of today's date, "scheduled" if it is announced for a future date, "ended" if it is over, "active" for a period currently running, "announced" if announced without a date, otherwise "unknown".
- Only include items relevant to the topic. Include every dated occurrence of the topic's kind that the document lists.
Output JSON matching the schema and nothing else.`;

function documentBlock(doc: AiDocument): { text: string; truncated: boolean } {
    const truncated = doc.text.length > MAX_DOCUMENT_CHARS;
    return { text: truncated ? doc.text.slice(0, MAX_DOCUMENT_CHARS) : doc.text, truncated };
}

function topicBlock(topic: ExtractionTopic, now: Date): string {
    return `Game: ${topic.gameName} (${topic.game})\nTopic: ${topic.type}\nWhat matters: ${topic.description}\nToday's date (UTC): ${now.toISOString().slice(0, 10)}`;
}

export async function classifyDocument(provider: AiProvider, topic: ExtractionTopic, doc: AiDocument, options: { now?: Date } = {}): Promise<{ classification: Classification; usage: AiUsage }> {
    const now = options.now ?? new Date();
    const { text, truncated } = documentBlock(doc);
    const prompt = `${topicBlock(topic, now)}\n\nDocument title: ${doc.title ?? ""}\n${truncated ? "(document truncated)\n" : ""}\n--- DOCUMENT ---\n${text}\n--- END ---`;
    const response = await provider.generateJson({ label: "classify", system: CLASSIFY_SYSTEM, prompt, schema: CLASSIFY_SCHEMA, maxOutputTokens: 1024 });
    return { classification: parseClassification(response.data), usage: response.usage };
}

export function parseClassification(data: unknown): Classification {
    const obj = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const docType = typeof obj.docType === "string" && (DOC_TYPES as string[]).includes(obj.docType) ? obj.docType as DocType : "unrelated";
    return {
        relevant: obj.relevant === true,
        docType,
        summary: typeof obj.summary === "string" ? obj.summary : "",
        reason: typeof obj.reason === "string" ? obj.reason : ""
    };
}

export interface RawField { field: DateField; value: string; timezone: string; quote: string }
export interface RawItem { kind: ItemKind; label: string; identity: string; status: ItemStatus; fields: RawField[] }

/** Coerces the model's JSON into RawItems, dropping anything that does not fit the schema. */
export function parseRawItems(data: unknown): { items: RawItem[]; dropped: number } {
    const obj = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const list = Array.isArray(obj.items) ? obj.items : [];
    const items: RawItem[] = [];
    let dropped = 0;
    for (const entry of list) {
        if (typeof entry !== "object" || entry === null) { dropped++; continue; }
        const e = entry as Record<string, unknown>;
        const kind = typeof e.kind === "string" && (ITEM_KINDS as string[]).includes(e.kind) ? e.kind as ItemKind : undefined;
        const label = typeof e.label === "string" ? e.label.trim() : "";
        const identity = typeof e.identity === "string" ? e.identity.trim() : "";
        const status = typeof e.status === "string" && (ITEM_STATUSES as string[]).includes(e.status) ? e.status as ItemStatus : "unknown";
        if (!kind || !identity) { dropped++; continue; }
        const fields: RawField[] = [];
        for (const f of Array.isArray(e.fields) ? e.fields : []) {
            if (typeof f !== "object" || f === null) { dropped++; continue; }
            const r = f as Record<string, unknown>;
            if (typeof r.field !== "string" || !(DATE_FIELDS as string[]).includes(r.field) || typeof r.value !== "string" || typeof r.quote !== "string") { dropped++; continue; }
            fields.push({ field: r.field as DateField, value: r.value.trim(), timezone: typeof r.timezone === "string" ? r.timezone.trim() : "", quote: r.quote });
        }
        items.push({ kind, label: label || identity, identity, status, fields });
    }
    return { items, dropped };
}

export interface GroundedFact extends NormalizedDate {
    field: DateField;
    /** The model's value as reported (ISO local). */
    value: string;
    timezoneRaw: string;
    quote: string;
    /** The quote states day and month but no year; the year came from the model's inference. */
    yearInferred: boolean;
}

export interface GroundedItem {
    kind: ItemKind;
    label: string;
    identity: string;
    /** normalizeIdentity(identity) */
    identityKey: string;
    status: ItemStatus;
    facts: GroundedFact[];
}

export interface RejectedField {
    identity: string;
    field: DateField;
    value: string;
    quote: string;
    reason: string;
}

export interface GroundedExtraction {
    items: GroundedItem[];
    rejected: RejectedField[];
    stats: { fields: number; accepted: number; rejected: number; itemsDropped: number; itemsRejected: number };
}

const QUOTE_MIN_LENGTH = 6;
const STOPWORDS = new Set(["the", "and", "for", "of", "to", "in", "on", "at", "a", "an", "patch", "update", "notes", "version", "season", "live"]);

function normalizeForSearch(text: string): string {
    return text
        .replace(/[‘’‚′]/g, "'")
        .replace(/[“”„″]/g, "\"")
        .replace(/[–—−]/g, "-")
        .replace(/ /g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function alnumOnly(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Tokens that carry meaning for matching an identity: digits/versions, or words of 3+ letters that are not generic. */
function significantTokens(identity: string): string[] {
    return identity.toLowerCase().split(/[^a-z0-9.]+/).map(t => t.replace(/^\.+|\.+$/g, "")).filter(t =>
        t.length > 0 && (/\d/.test(t) || (t.length >= 3 && !STOPWORDS.has(t))));
}

interface PreparedDocument { normalized: string; alnum: string }

function prepare(documentText: string): PreparedDocument {
    return { normalized: normalizeForSearch(documentText), alnum: alnumOnly(documentText) };
}

/** True when the quote occurs verbatim in the document (whitespace/quote-mark tolerant, then punctuation tolerant). */
export function quoteOccursIn(quote: string, documentText: string, prepared?: PreparedDocument): boolean {
    const q = normalizeForSearch(quote);
    if (q.length < QUOTE_MIN_LENGTH) return false;
    const doc = prepared ?? prepare(documentText);
    if (doc.normalized.includes(q)) return true;
    const qa = alnumOnly(quote);
    return qa.length >= QUOTE_MIN_LENGTH && doc.alnum.includes(qa);
}

/**
 * True when the document actually contains the identity: either verbatim
 * (punctuation-insensitive) or every significant token of it.
 */
export function identityOccursIn(identity: string, documentText: string, prepared?: PreparedDocument): boolean {
    const doc = prepared ?? prepare(documentText);
    const whole = alnumOnly(identity);
    if (whole.length >= 2 && doc.alnum.includes(whole)) return true;
    const tokens = significantTokens(identity);
    return tokens.length > 0 && tokens.every(t => doc.alnum.includes(alnumOnly(t)));
}

/** True when the quote names the item it is evidence for: the whole identity, or at least one significant token of it. */
export function quoteNamesIdentity(quote: string, identity: string): boolean {
    const q = alnumOnly(quote);
    const whole = alnumOnly(identity);
    if (whole.length >= 2 && q.includes(whole)) return true;
    return significantTokens(identity).some(t => q.includes(alnumOnly(t)));
}

export function groundExtraction(raw: { items: RawItem[]; dropped: number }, documentText: string): GroundedExtraction {
    const prepared = prepare(documentText);
    const items: GroundedItem[] = [];
    const rejected: RejectedField[] = [];
    let fieldsSeen = 0;
    let accepted = 0;
    let itemsRejected = 0;

    for (const item of raw.items) {
        let identityKey: string;
        try {
            identityKey = normalizeIdentity(item.identity);
        } catch {
            itemsRejected++;
            rejected.push({ identity: item.identity, field: "at", value: "", quote: "", reason: "identity cannot be normalized" });
            continue;
        }
        if (!identityOccursIn(item.identity, documentText, prepared)) {
            itemsRejected++;
            fieldsSeen += item.fields.length;
            rejected.push({ identity: item.identity, field: "at", value: "", quote: "", reason: "identity not found in document" });
            continue;
        }

        const facts: GroundedFact[] = [];
        for (const f of item.fields) {
            fieldsSeen++;
            const reject = (reason: string) => rejected.push({ identity: item.identity, field: f.field, value: f.value, quote: f.quote, reason });

            if (!f.quote || f.quote.trim().length < QUOTE_MIN_LENGTH) { reject("quote missing or too short"); continue; }
            if (!quoteOccursIn(f.quote, documentText, prepared)) { reject("quote not found in document"); continue; }
            if (!quoteNamesIdentity(f.quote, item.identity)) { reject("quote does not mention the item"); continue; }
            const parsed = parseDateValue(f.value);
            if (!parsed) { reject(`value is not an ISO date: ${JSON.stringify(f.value)}`); continue; }
            const mention = quoteMentionsDate(f.quote, parsed);
            if (!mention.day || !mention.month) { reject("quote does not mention the claimed day and month"); continue; }
            if (mention.year === false) { reject("quote states a different year"); continue; }

            let normalized = normalizeDateFact(f.value, f.timezone);
            if (!normalized) { reject("date could not be normalized"); continue; }

            // A clock time and its zone must be stated too; otherwise keep the day and drop the time.
            if (normalized.precision === "exact") {
                if (!quoteMentionsTime(f.quote, parsed)) {
                    normalized = { ...normalizeDateFact(f.value.slice(0, 10), undefined)!, note: "quote does not state the claimed clock time; time dropped" };
                } else if (parsed.offsetMinutes === undefined && !timezoneMentioned(documentText, f.quote, f.timezone)) {
                    normalized = { ...normalizeDateFact(f.value.slice(0, 10), undefined)!, note: `timezone "${f.timezone}" not stated in the document; time dropped` };
                }
            }

            facts.push({ ...normalized, field: f.field, value: f.value, timezoneRaw: f.timezone, quote: f.quote, yearInferred: mention.year === null });
            accepted++;
        }
        items.push({ kind: item.kind, label: item.label, identity: item.identity, identityKey, status: item.status, facts });
    }

    return { items, rejected, stats: { fields: fieldsSeen, accepted, rejected: rejected.length, itemsDropped: raw.dropped, itemsRejected } };
}

export interface ExtractionResult {
    raw: { items: RawItem[]; dropped: number };
    grounded: GroundedExtraction;
    usage: AiUsage;
    truncated: boolean;
}

export async function extractFacts(provider: AiProvider, topic: ExtractionTopic, doc: AiDocument, options: { now?: Date } = {}): Promise<ExtractionResult> {
    const now = options.now ?? new Date();
    const { text, truncated } = documentBlock(doc);
    const prompt = `${topicBlock(topic, now)}\n\nDocument title: ${doc.title ?? ""}\n${truncated ? "(document truncated)\n" : ""}\n--- DOCUMENT ---\n${text}\n--- END ---`;
    const response = await provider.generateJson({ label: "extract", system: EXTRACT_SYSTEM, prompt, schema: EXTRACT_SCHEMA, maxOutputTokens: 8192 });
    const raw = parseRawItems(response.data);
    // Ground against the text the model actually saw.
    const grounded = groundExtraction(raw, text);
    return { raw, grounded, usage: response.usage, truncated };
}
