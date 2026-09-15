/**
 * AI-assisted extraction with deterministic grounding.
 *
 *   classifyDocument  -> is this document about the topic, and what kind is it?
 *   extractFacts      -> items (version / period / occurrence) with date fields,
 *                        each field carrying the verbatim quote that states it
 *   groundExtraction  -> deterministic checks: the item's identity occurs in the
 *                        document; the quote occurs in the document and names the
 *                        item's discriminating words; the quote states the claimed
 *                        day and month; a stated year must match and an inferred
 *                        year must be supported by the document or by today; a
 *                        claimed clock time, timezone or offset must be evidenced
 *                        or the fact is downgraded to day precision. Anything else
 *                        is rejected with a reason.
 *
 * The model never sees a URL it could echo as evidence, never assigns confidence,
 * and never decides what gets published.
 */
import { normalizeIdentity } from "../identity";
import { NormalizedDate, ParsedDateValue, ResolvedZone, clockTimesIn, dateEntries, datePreamble, normalizeDateFact, zoneAfterClock, parseDateValue, quoteMentionsDate, quoteMentionsTime, resolveTimezone, zoneDeclaredIn, zoneOffsetAt, zonesIn } from "./dates";
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
        docType: { type: "string", enum: DOC_TYPES, description: "patch-notes = published notes for one or more released updates (including a list of them); patch-schedule = a plan of upcoming patch dates; season = season/act/split information; banner = gacha banner information; maintenance = downtime notice; release = launch/version announcement; news = other news; unrelated = none of these" },
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
                                value: { type: "string", description: "ISO 8601: YYYY-MM-DD when only a date is stated, YYYY-MM-DDTHH:MM when a time is stated (local to the stated timezone). Never append an offset or Z; put the timezone in the timezone field." },
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
Answer only from the document text. Decide whether the document states facts that are useful for the given topic (dates, versions, seasons, banners, maintenance windows) and what kind of document it is:
- patch-notes: published notes for one or more released updates, including an index or listing of them
- patch-schedule: a plan of upcoming patch dates
- season: season, act or split information; banner: gacha banner information; maintenance: a downtime notice; release: a launch or version announcement; news: other news; unrelated: none of these
Output JSON matching the schema and nothing else.`;

const EXTRACT_SYSTEM = `You extract time-sensitive facts about a video game from a single document.
Rules:
- Use only information stated in the document. Never guess or invent a date. If the document states no date for an item, return the item with an empty fields array.
- For every date field, copy the exact fragment of the document that states it into "quote", verbatim, character for character. The quote must be one contiguous passage as it appears in the document: never join separate passages, reorder text, or insert line breaks between fragments. It must include the item's name or version and the date text, and the time when you report one. Keep it short: the smallest such passage (one sentence, heading or table row, normally under 200 characters). Do not paraphrase, shorten words, or fix punctuation.
- Return at most 40 items; when a document lists more, keep the most recent ones.
- "value" is ISO 8601: YYYY-MM-DD when only a date is stated; YYYY-MM-DDTHH:MM when a time is stated (local to the stated timezone). Never append an offset or Z. If the document states a day and month but no year, take the year from the document's own posting/update dates.
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
    /** The quote states day and month but no year; the year was inferred and checked against the document. */
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
/** Generic words that never identify an item on their own. */
const STOPWORDS = new Set(["the", "and", "for", "of", "to", "in", "on", "at", "a", "an", "is", "it"]);
/** Words that describe the kind of item; they cannot be the discriminator between two items of that kind. */
const KIND_WORDS = new Set(["patch", "update", "updates", "notes", "version", "season", "live", "maintenance", "hotfix", "release", "downtime", "servers", "server", "schedule", "changelog"]);
const MONTH_WORDS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

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

/**
 * Word/number tokens of a text, lower-cased. Periods inside a token are kept so
 * "26.19" stays one token distinct from "6.19"; surrounding punctuation is dropped.
 */
export function tokensOf(text: string): string[] {
    return normalizeForSearch(text).split(/[^a-z0-9.]+/).map(t => t.replace(/^\.+|\.+$/g, "")).filter(t => t.length > 0);
}

/** Tokens that carry meaning for matching an identity: anything with a digit, or a word of 2+ letters that is not a stopword. */
function significantTokens(identity: string): string[] {
    return tokensOf(identity).filter(t => /\d/.test(t) || (t.length >= 2 && !STOPWORDS.has(t)));
}

/** A token that is part of a date (month name, day number, year) cannot discriminate between items. */
function isDateToken(token: string): boolean {
    return MONTH_WORDS.has(token) || /^\d{1,2}$/.test(token) || /^(19|20)\d{2}$/.test(token);
}

interface PreparedDocument { normalized: string; tokenText: string; tokens: Set<string>; years: Set<number> }

function prepare(documentText: string): PreparedDocument {
    const years = new Set<number>();
    for (const m of documentText.matchAll(/\b(19|20)\d{2}\b/g)) years.add(+m[0]);
    const tokens = tokensOf(documentText);
    return { normalized: normalizeForSearch(documentText), tokenText: ` ${tokens.join(" ")} `, tokens: new Set(tokens), years };
}

/**
 * True when the quote occurs verbatim in the document: whitespace/quote-mark
 * tolerant first, then punctuation tolerant with token boundaries kept, so
 * "September 2 3, 2026" never passes as "September 23, 2026".
 */
export function quoteOccursIn(quote: string, documentText: string, prepared?: PreparedDocument): boolean {
    const q = normalizeForSearch(quote);
    if (q.length < QUOTE_MIN_LENGTH) return false;
    const doc = prepared ?? prepare(documentText);
    if (doc.normalized.includes(q)) return true;
    const qt = tokensOf(quote).join(" ");
    return qt.length >= QUOTE_MIN_LENGTH && doc.tokenText.includes(` ${qt} `);
}

/**
 * True when the document actually contains the identity: every significant
 * token of it occurs as a whole token ("6.19" does not occur in a document that
 * only mentions "26.19").
 */
export function identityOccursIn(identity: string, documentText: string, prepared?: PreparedDocument): boolean {
    const doc = prepared ?? prepare(documentText);
    const tokens = significantTokens(identity);
    return tokens.length > 0 && tokens.every(t => doc.tokens.has(t));
}

/**
 * True when the quote names the item it is evidence for. Every discriminating
 * token of the identity (not a date part, not a generic kind word) must occur in
 * the quote as a whole token; an identity made only of date parts and kind words
 * must occur in full.
 */
export function quoteNamesIdentity(quote: string, identity: string): boolean {
    const quoteTokens = new Set(tokensOf(quote));
    const tokens = significantTokens(identity);
    const discriminators = tokens.filter(t => !isDateToken(t) && !KIND_WORDS.has(t));
    const required = discriminators.length > 0 ? discriminators : tokens;
    return required.length > 0 && required.every(t => quoteTokens.has(t));
}

/**
 * True when one entry of a quote (see dateEntries) belongs to the item: every
 * discriminating token of the identity occurs in it. An identity with nothing
 * to discriminate by ("Maintenance March 11") cannot be told apart, so the
 * quote-level check (quoteNamesIdentity) is all that applies to it.
 */
export function entryNamesItem(entry: string, identity: string): boolean {
    const discriminators = discriminatorsOf(identity);
    if (discriminators.length === 0) return true;
    const entryTokens = new Set(tokensOf(entry));
    return discriminators.every(t => entryTokens.has(t));
}

function discriminatorsOf(identity: string): string[] {
    return significantTokens(identity).filter(t => !isDateToken(t) && !KIND_WORDS.has(t));
}

function hasDiscriminators(identity: string): boolean {
    return discriminatorsOf(identity).length > 0;
}

/**
 * A start/end pair must be ordered, and when both come from one quote the start
 * time must precede the end time in it ("00:00 - 08:30" cannot ground start=08:30).
 */
function rangeIsConsistent(start: GroundedFact, end: GroundedFact): boolean {
    if (start.precision === "exact" && end.precision === "exact") {
        if (Date.parse(start.at) > Date.parse(end.at)) return false;
    } else if (start.value.slice(0, 10) > end.value.slice(0, 10)) {
        // A day-precision bound is a calendar day, not an instant: compare the stated days.
        return false;
    }
    if (start.precision === "exact" && end.precision === "exact" && normalizeForSearch(start.quote) === normalizeForSearch(end.quote)) {
        const times = clockTimesIn(start.quote);
        const s = parseDateValue(start.value), e = parseDateValue(end.value);
        if (s?.hasTime && e?.hasTime) {
            const startIndex = times.indexOf((s.hour ?? 0) * 60 + (s.minute ?? 0));
            const endIndex = times.lastIndexOf((e.hour ?? 0) * 60 + (e.minute ?? 0));
            if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) return false;
        }
    }
    return true;
}

/** An inferred year is credible only if the document states it, or it is this year or next. */
function inferredYearSupported(year: number, prepared: PreparedDocument, now: Date): boolean {
    const thisYear = now.getUTCFullYear();
    return prepared.years.has(year) || year === thisYear || year === thisYear + 1;
}

/** True when the quote carries an ISO timestamp with the same offset the value embeds ("...Z", "+08:00", "-0500"). */
function quoteCarriesOffset(quote: string, offsetMinutes: number): boolean {
    for (const m of quote.matchAll(/\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(z|[+-]\d{2}:?\d{2})\b/gi)) {
        const token = m[1].toUpperCase();
        if (token === "Z" && offsetMinutes === 0) return true;
        const o = /^([+-])(\d{2}):?(\d{2})$/.exec(token);
        if (o && (o[1] === "-" ? -1 : 1) * (+o[2] * 60 + +o[3]) === offsetMinutes) return true;
    }
    return false;
}

/**
 * Which stated timezone applies to a fact: a zone next to the date (inside its
 * segment) wins; a zone stated elsewhere in the quote belongs to another entry
 * and makes the fact ambiguous; otherwise a zone stated anywhere in the document
 * (typically a header such as "all times PT") applies.
 */
function evidencedZone(documentText: string, quote: string, segment: string, timezoneRaw: string, value: ParsedDateValue): { zone?: ResolvedZone; problem?: string } {
    const claimed = resolveTimezone(timezoneRaw);
    // A zone next to the date applies; so does one the quote's header (before any date) declares
    // for its times ("Live Maintenance Schedule (UTC) ..."), but not a header zone in some other
    // context ("Support hours are PT."). When the entry states several clock/zone pairs
    // ("15:00 PT / 18:00 ET"), only the zone right after the claimed clock counts.
    const inSegment = zonesIn(segment);
    if (inSegment.length > 1) {
        const adjacent = zoneAfterClock(segment, value);
        if (!adjacent) return { problem: "the entry states several timezones and none is next to the claimed clock time; time dropped" };
        if (claimed && adjacent.zone !== claimed.zone && zoneOffsetAt(adjacent, value) !== zoneOffsetAt(claimed, value)) {
            return { problem: `the claimed clock time is stated in ${adjacent.zone}, not "${timezoneRaw}"; time dropped` };
        }
        return { zone: adjacent };
    }
    const preamble = datePreamble(quote);
    const stated = inSegment[0] ?? zonesIn(preamble).find(z => zoneDeclaredIn(preamble, z));
    if (stated) {
        if (claimed && stated.zone !== claimed.zone && zoneOffsetAt(stated, value) !== zoneOffsetAt(claimed, value)) {
            return { problem: `quote states ${stated.zone} next to this date, not "${timezoneRaw}"; time dropped` };
        }
        return { zone: stated };
    }
    if (zonesIn(quote).length > 0) return { problem: "the timezone in the quote belongs to another entry; time dropped" };
    if (!claimed || !zoneDeclaredIn(documentText, claimed)) return { problem: `timezone "${timezoneRaw}" is not declared for times in the document; time dropped` };
    return { zone: claimed };
}

export function groundExtraction(raw: { items: RawItem[]; dropped: number }, documentText: string, options: { now?: Date } = {}): GroundedExtraction {
    const now = options.now ?? new Date();
    const prepared = prepare(documentText);
    const items: GroundedItem[] = [];
    const rejected: RejectedField[] = [];
    let fieldsSeen = 0;
    let accepted = 0;
    let itemsRejected = 0;

    for (const item of raw.items) {
        let identityKey: string;
        // A rejected item discards every field it carried: one rejection per field (or one for the item when it had none).
        const rejectItem = (reason: string) => {
            itemsRejected++;
            fieldsSeen += item.fields.length;
            if (item.fields.length === 0) rejected.push({ identity: item.identity, field: "at", value: "", quote: "", reason });
            for (const f of item.fields) rejected.push({ identity: item.identity, field: f.field, value: f.value, quote: f.quote, reason });
        };
        try {
            identityKey = normalizeIdentity(item.identity);
        } catch {
            rejectItem("identity cannot be normalized");
            continue;
        }
        if (!identityOccursIn(item.identity, documentText, prepared)) {
            rejectItem("identity not found in document");
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
            if (mention.year === null && !inferredYearSupported(parsed.year, prepared, now)) { reject(`inferred year ${parsed.year} is not supported by the document`); continue; }

            let normalized = normalizeDateFact(f.value, f.timezone);
            if (!normalized) { reject("date could not be normalized"); continue; }

            // The date must sit in an entry of the quote that names this item: a quote listing several
            // entries ("PC ... September 23 ...; Console ... TBD") cannot lend one entry's date, time or
            // zone to another.
            const entries = dateEntries(f.quote, parsed);
            const own = entries.filter(e => entryNamesItem(e.entry, item.identity));
            if (entries.length > 0 && own.length === 0) { reject("the date in the quote belongs to another entry, not this item"); continue; }

            // A clock time, and the zone or offset it is expressed in, must be evidenced by that
            // entry too. Otherwise keep the day and drop the time.
            if (normalized.precision === "exact") {
                const dayFallback = (note: string) => ({ ...normalizeDateFact(f.value.slice(0, 10), undefined)!, note });
                // Several same-date entries that the identity cannot tell apart never lend a time.
                const timed = own.length > 1 && !hasDiscriminators(item.identity) ? [] : own.filter(e => quoteMentionsTime(e.segment, parsed));
                const segment = entries.length === 0 ? f.quote : timed.length === 1 ? timed[0].segment : undefined;
                if (segment === undefined) {
                    normalized = dayFallback(own.length > 1
                        ? "several entries in the quote share this date and none is clearly this item; time dropped"
                        : "quote does not state the claimed clock time next to the date; time dropped");
                } else if (parsed.offsetMinutes !== undefined) {
                    const evidence = evidencedZone(documentText, f.quote, segment, f.timezone, parsed);
                    const statedOffset = evidence.zone ? zoneOffsetAt(evidence.zone, parsed) : undefined;
                    if (!quoteCarriesOffset(segment, parsed.offsetMinutes) && statedOffset !== parsed.offsetMinutes) {
                        normalized = dayFallback("embedded UTC offset is not evidenced by the quote or a stated timezone; time dropped");
                    }
                } else {
                    const evidence = evidencedZone(documentText, f.quote, segment, f.timezone, parsed);
                    if (evidence.problem) normalized = dayFallback(evidence.problem);
                }
            }

            // One value per item and field: a repeated identical fact is dropped quietly; a
            // conflicting one makes the field ambiguous and takes the earlier fact down with it.
            const earlier = facts.find(x => x.field === f.field);
            if (earlier) {
                if (earlier.at === normalized.at && earlier.precision === normalized.precision) { fieldsSeen--; continue; }
                facts.splice(facts.indexOf(earlier), 1);
                accepted--;
                rejected.push({ identity: item.identity, field: earlier.field, value: earlier.value, quote: earlier.quote, reason: "conflicting values for the same field" });
                reject("conflicting values for the same field");
                continue;
            }

            facts.push({ ...normalized, field: f.field, value: f.value, timezoneRaw: f.timezone, quote: f.quote, yearInferred: mention.year === null });
            accepted++;
        }

        // A window whose grounded start is after its end, or whose times are read in the wrong order, is not evidence.
        const start = facts.find(f => f.field === "startAt");
        const end = facts.find(f => f.field === "endAt");
        if (start && end && !rangeIsConsistent(start, end)) {
            for (const f of [start, end]) {
                rejected.push({ identity: item.identity, field: f.field, value: f.value, quote: f.quote, reason: "start/end are inverted or read out of order" });
            }
            accepted -= 2;
            facts.splice(facts.indexOf(start), 1);
            facts.splice(facts.indexOf(end), 1);
        }

        items.push({ kind: item.kind, label: item.label, identity: item.identity, identityKey, status: item.status, facts });
    }

    // stats.rejected counts fields, so fields == accepted + rejected; a rejected item without fields adds only a list entry.
    return { items, rejected, stats: { fields: fieldsSeen, accepted, rejected: fieldsSeen - accepted, itemsDropped: raw.dropped, itemsRejected } };
}

export interface ExtractionResult {
    raw: { items: RawItem[]; dropped: number };
    grounded: GroundedExtraction;
    /** Usage of all calls made (one, or two when a repair was attempted). */
    usage: AiUsage;
    truncated: boolean;
    /** Model calls made: 1, or 2 when quotes had to be repaired. */
    attempts: number;
    /** True when the repaired answer replaced the first one. */
    repaired: boolean;
    /** Set when the repair call itself failed (the first answer stands). */
    repairError?: string;
}

const UNVERIFIABLE_QUOTE = "quote not found in document";
/** Long changelogs can make the model enumerate many items; leave ample room so valid JSON is never cut off. */
const EXTRACT_MAX_OUTPUT_TOKENS = 16384;

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
    const thought = (a.thoughtTokens ?? 0) + (b.thoughtTokens ?? 0);
    return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, ...(thought > 0 ? { thoughtTokens: thought } : {}) };
}

/**
 * Fills the first answer's unverifiable gaps from the repaired answer: a fact
 * is taken from the repair only for an item and field the first answer could
 * not evidence. Facts the first answer already grounded are never replaced, and
 * items the repair invents are ignored.
 */
export function mergeRepair(first: GroundedExtraction, repair: GroundedExtraction): { merged: GroundedExtraction; filled: number } {
    const items = first.items.map(i => ({ ...i, facts: [...i.facts] }));
    const rejected = [...first.rejected];
    const fromRepair = new Set<GroundedFact>();
    for (const gap of first.rejected.filter(r => r.reason === UNVERIFIABLE_QUOTE)) {
        const item = items.find(i => i.identity === gap.identity);
        if (!item || item.facts.some(f => f.field === gap.field)) continue;
        const fact = repair.items.find(i => i.identityKey === item.identityKey)?.facts.find(f => f.field === gap.field);
        if (!fact) continue;
        item.facts.push(fact);
        fromRepair.add(fact);
        rejected.splice(rejected.indexOf(gap), 1);
    }
    // A filled bound must still form a consistent window with what was already accepted.
    for (const item of items) {
        const start = item.facts.find(f => f.field === "startAt");
        const end = item.facts.find(f => f.field === "endAt");
        if (!start || !end || rangeIsConsistent(start, end)) continue;
        for (const f of [start, end].filter(f => fromRepair.has(f))) {
            item.facts.splice(item.facts.indexOf(f), 1);
            fromRepair.delete(f);
            rejected.push({ identity: item.identity, field: f.field, value: f.value, quote: f.quote, reason: "start/end are inverted or read out of order" });
        }
    }
    const filled = fromRepair.size;
    const accepted = first.stats.accepted + filled;
    return { merged: { items, rejected, stats: { ...first.stats, accepted, rejected: first.stats.fields - accepted } }, filled };
}

/**
 * Extracts and grounds. When the model's quotes are not verbatim (paraphrased,
 * reordered or stitched from separate passages), one repair call names the
 * offending quotes and asks again; the repaired answer is grounded exactly like
 * the first and only fills the gaps it left (see mergeRepair). Never more than two calls.
 */
export async function extractFacts(provider: AiProvider, topic: ExtractionTopic, doc: AiDocument, options: { now?: Date; repair?: boolean } = {}): Promise<ExtractionResult> {
    const now = options.now ?? new Date();
    const { text, truncated } = documentBlock(doc);
    const prompt = `${topicBlock(topic, now)}\n\nDocument title: ${doc.title ?? ""}\n${truncated ? "(document truncated)\n" : ""}\n--- DOCUMENT ---\n${text}\n--- END ---`;
    const response = await provider.generateJson({ label: "extract", system: EXTRACT_SYSTEM, prompt, schema: EXTRACT_SCHEMA, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS });
    const raw = parseRawItems(response.data);
    // Ground against the text the model actually saw.
    let grounded = groundExtraction(raw, text, { now });
    let usage = response.usage;
    let attempts = 1;
    let repaired = false;
    let repairError: string | undefined;

    const unverifiable = grounded.rejected.filter(r => r.reason === UNVERIFIABLE_QUOTE);
    if ((options.repair ?? true) && unverifiable.length > 0) {
        const list = unverifiable.map(r => `- item ${JSON.stringify(r.identity)}, field ${r.field}: ${JSON.stringify(r.quote)}`).join("\n");
        const repairPrompt = `${prompt}\n\n--- CORRECTIONS NEEDED ---\nThese quotes from your previous answer do not occur verbatim in the document (paraphrased, reordered, or stitched from separate passages):\n${list}\nAnswer again with the complete result. Every quote must be one contiguous passage copied exactly from the document. Leave out any date you cannot quote exactly.`;
        attempts = 2;
        try {
            const second = await provider.generateJson({ label: "extract-repair", system: EXTRACT_SYSTEM, prompt: repairPrompt, schema: EXTRACT_SCHEMA, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS });
            usage = addUsage(usage, second.usage);
            const groundedRepair = groundExtraction(parseRawItems(second.data), text, { now });
            const { merged, filled } = mergeRepair(grounded, groundedRepair);
            if (filled > 0) {
                grounded = merged;
                repaired = true;
            }
        } catch (error) {
            // The repair is best effort: a failed second call never costs the grounded first answer.
            repairError = error instanceof Error ? error.message : String(error);
        }
    }
    return { raw, grounded, usage, truncated, attempts, repaired, ...(repairError !== undefined ? { repairError } : {}) };
}
