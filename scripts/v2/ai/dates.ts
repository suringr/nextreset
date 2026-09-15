/**
 * Deterministic date handling for extracted facts.
 *
 * A model reports a date value and the timezone phrase it saw; this module
 * decides what that means: parse the value without touching the runner's local
 * timezone, resolve the timezone phrase to an IANA zone or a fixed offset,
 * convert to a UTC instant, and decide the precision. It also checks that a
 * quote actually mentions the date, and the clock time, it is supposed to
 * support.
 */

export interface ParsedDateValue {
    year: number;
    month: number; // 1-12
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
    hasTime: boolean;
    /** Offset in minutes when the value itself carries Z or ±HH:MM. */
    offsetMinutes?: number;
}

const ISO_VALUE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]`. Local-time values keep no zone. */
export function parseDateValue(value: string): ParsedDateValue | undefined {
    const m = ISO_VALUE.exec(value.trim());
    if (!m) return undefined;
    const year = +m[1], month = +m[2], day = +m[3];
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
    const parsed: ParsedDateValue = { year, month, day, hasTime: m[4] !== undefined };
    if (parsed.hasTime) {
        parsed.hour = +m[4];
        parsed.minute = +m[5];
        parsed.second = m[6] !== undefined ? +m[6] : 0;
        if (parsed.hour > 23 || parsed.minute > 59 || parsed.second > 59) return undefined;
    }
    if (m[7]) {
        parsed.offsetMinutes = m[7] === "Z" ? 0 : offsetToMinutes(m[7]);
        if (!parsed.hasTime) return undefined; // an offset without a time is meaningless
    }
    return parsed;
}

function offsetToMinutes(text: string): number {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(text)!;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (+m[2] * 60 + +m[3]);
}

/** Generic phrases whose offset depends on the date: resolved through IANA rules (DST-aware). */
const IANA_ALIASES: Record<string, string> = {
    "utc": "UTC", "gmt": "UTC", "z": "UTC", "coordinated universal time": "UTC",
    "pt": "America/Los_Angeles", "pacific": "America/Los_Angeles", "pacific time": "America/Los_Angeles",
    "et": "America/New_York", "eastern": "America/New_York", "eastern time": "America/New_York",
    "ct": "America/Chicago", "central time": "America/Chicago",
    "mt": "America/Denver", "mountain time": "America/Denver",
    "uk time": "Europe/London", "london time": "Europe/London",
    "central european time": "Europe/Berlin", "paris time": "Europe/Paris", "berlin time": "Europe/Berlin",
    "korea time": "Asia/Seoul", "japan time": "Asia/Tokyo"
};

/**
 * Explicit standard/daylight abbreviations name a fixed offset; they must not
 * drift with the date (12:00 PST in July is still UTC-8 by definition).
 */
const FIXED_ALIASES: Record<string, string> = {
    "pst": "-08:00", "pdt": "-07:00", "pacific standard time": "-08:00", "pacific daylight time": "-07:00",
    "est": "-05:00", "edt": "-04:00", "eastern standard time": "-05:00", "eastern daylight time": "-04:00",
    "cdt": "-05:00", "mst": "-07:00", "mdt": "-06:00",
    "bst": "+01:00", "cet": "+01:00", "cest": "+02:00", "eet": "+02:00", "eest": "+03:00",
    "kst": "+09:00", "jst": "+09:00", "aest": "+10:00", "aedt": "+11:00",
    "korea standard time": "+09:00", "japan standard time": "+09:00"
};

export interface ResolvedZone {
    /** IANA zone name, "UTC", or a fixed offset such as "+08:00". */
    zone: string;
    kind: "iana" | "offset" | "utc";
}

function isValidIana(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** Resolves a timezone phrase as a document states it. Ambiguous or unknown phrases ("IST", "server time") resolve to undefined. */
export function resolveTimezone(raw: string | undefined): ResolvedZone | undefined {
    if (!raw) return undefined;
    const cleaned = raw.trim().replace(/[()]/g, "").replace(/\s+/g, " ");
    if (cleaned.length === 0) return undefined;
    const lower = cleaned.toLowerCase();

    const offset = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(lower);
    if (offset) {
        const hours = +offset[2], minutes = offset[3] ? +offset[3] : 0;
        if (hours > 14 || minutes > 59) return undefined;
        if (hours === 0 && minutes === 0) return { zone: "UTC", kind: "utc" };
        const zone = `${offset[1]}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
        return { zone, kind: "offset" };
    }
    if (lower in FIXED_ALIASES) return { zone: FIXED_ALIASES[lower], kind: "offset" };
    if (lower in IANA_ALIASES) {
        const zone = IANA_ALIASES[lower];
        return { zone, kind: zone === "UTC" ? "utc" : "iana" };
    }
    if (/^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(cleaned) && isValidIana(cleaned)) {
        return { zone: cleaned, kind: "iana" };
    }
    return undefined;
}

function tzOffsetMinutes(zone: string, at: Date): number {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
    const hour = parts.hour === "24" ? 0 : +parts.hour;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
    return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Converts a wall-clock time in a zone (IANA name, "+HH:MM" offset, or "UTC")
 * to a UTC instant. DST-safe; a wall time that does not exist in the zone (the
 * skipped hour of a spring-forward transition) has no instant and yields undefined.
 */
export function zonedToUtc(value: ParsedDateValue, zone: string): Date | undefined {
    return zonedToUtcDetailed(value, zone).at;
}

export type WallTimeProblem = "nonexistent" | "ambiguous";

/**
 * As zonedToUtc, but says why there is no instant: the wall time falls in a
 * spring-forward gap (nonexistent) or in a fall-back overlap where two instants
 * read back as the same wall time (ambiguous). Fixed offsets never have either.
 */
export function zonedToUtcDetailed(value: ParsedDateValue, zone: string): { at?: Date; problem?: WallTimeProblem } {
    const wall = Date.UTC(value.year, value.month - 1, value.day, value.hour ?? 0, value.minute ?? 0, value.second ?? 0);
    if (zone === "UTC") return { at: new Date(wall) };
    const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
    if (fixed) {
        const minutes = (fixed[1] === "-" ? -1 : 1) * (+fixed[2] * 60 + +fixed[3]);
        return { at: new Date(wall - minutes * 60000) };
    }
    // The instant lies within 15 hours of the wall time read as UTC. Any transition in that
    // window shows up as two different offsets at its ends; each offset gives a candidate
    // instant, kept only if it reads back as the requested wall time.
    const HOUR = 3600000;
    const before = tzOffsetMinutes(zone, new Date(wall - 15 * HOUR));
    const after = tzOffsetMinutes(zone, new Date(wall + 15 * HOUR));
    const candidates = new Set<number>();
    for (const offset of before === after ? [before] : [before, after]) {
        const guess = wall - offset * 60000;
        if (tzOffsetMinutes(zone, new Date(guess)) === offset) candidates.add(guess);
    }
    if (candidates.size === 0) return { problem: "nonexistent" };
    if (candidates.size > 1) return { problem: "ambiguous" };
    return { at: new Date([...candidates][0]) };
}

/** Minutes east of UTC that a resolved zone has at a wall-clock value; undefined for a nonexistent wall time. */
export function zoneOffsetAt(zone: ResolvedZone, value: ParsedDateValue): number | undefined {
    const wall = Date.UTC(value.year, value.month - 1, value.day, value.hour ?? 0, value.minute ?? 0, value.second ?? 0);
    const at = zonedToUtc({ ...value, offsetMinutes: undefined }, zone.zone);
    return at ? Math.round((wall - at.getTime()) / 60000) : undefined;
}

export interface NormalizedDate {
    /** UTC instant (ISO). For day precision: midnight UTC of the stated calendar day. */
    at: string;
    precision: "exact" | "day";
    /** Resolved zone the instant was computed in, when one was stated and understood. */
    timezone?: string;
    /** Set when a stated time could not be used (unknown zone): the day is kept, the time is dropped. */
    note?: string;
}

function dayOnly(parsed: ParsedDateValue, note?: string, timezone?: string): NormalizedDate {
    const result: NormalizedDate = { at: new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).toISOString(), precision: "day" };
    if (timezone !== undefined) result.timezone = timezone;
    if (note !== undefined) result.note = note;
    return result;
}

/** Turns a model-reported value + timezone phrase into an Event-compatible instant. */
export function normalizeDateFact(value: string, timezoneRaw: string | undefined): NormalizedDate | undefined {
    const parsed = parseDateValue(value);
    if (!parsed) return undefined;

    if (parsed.offsetMinutes !== undefined) {
        const wall = Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour ?? 0, parsed.minute ?? 0, parsed.second ?? 0);
        const offset = parsed.offsetMinutes;
        const zone = offset === 0 ? "UTC" : `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
        return { at: new Date(wall - offset * 60000).toISOString(), precision: "exact", timezone: zone };
    }

    const zone = resolveTimezone(timezoneRaw);
    if (!parsed.hasTime) return dayOnly(parsed, undefined, zone?.zone);
    if (!zone) {
        return dayOnly(parsed, timezoneRaw && timezoneRaw.trim()
            ? `timezone "${timezoneRaw.trim()}" not understood; time dropped`
            : "time stated without a timezone; time dropped");
    }
    const converted = zonedToUtcDetailed(parsed, zone.zone);
    if (!converted.at) {
        const why = converted.problem === "ambiguous" ? "occurs twice (DST fall-back); a fixed offset or PDT/PST-style abbreviation would disambiguate" : "does not exist (DST transition)";
        return dayOnly(parsed, `${value.slice(11, 16)} in ${zone.zone} on that day ${why}; time dropped`, zone.zone);
    }
    return { at: converted.at.toISOString(), precision: "exact", timezone: zone.zone };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export interface QuoteDateCheck {
    day: boolean;
    month: boolean;
    /** null when the quote contains no four-digit year at all. */
    year: boolean | null;
}

/**
 * Does the quote actually mention the date it is claimed to support?
 *
 * The month and day must form one date expression ("September 23", "23 Sept.",
 * "2026-09-23", "9/23"); components of different dates in the same quote never
 * combine. A day number is never a component of a decimal/version number such as
 * "26.19". Year: true/false when a four-digit year is attached to that same
 * expression, null when the expression states none.
 */
export function quoteMentionsDate(quote: string, value: ParsedDateValue): QuoteDateCheck {
    const q = collapse(quote);
    const mention = findDateMention(q, value);
    if (mention) return { day: true, month: true, year: mention.year };

    const monthOnly = new RegExp(`\\b${monthWordPattern(value.month)}\\b`).test(q);
    const years = q.match(/\b(19|20)\d{2}\b/g);
    return { day: false, month: monthOnly, year: years ? years.includes(String(value.year)) : null };
}

function collapse(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ");
}

function monthWordPattern(month: number): string {
    const name = MONTHS[month - 1];
    return month === 9 ? "(?:september|sept?\\.?)" : `(?:${name}|${name.slice(0, 3)}\\.?)`;
}

interface DateMention {
    start: number;
    end: number;
    /** true/false when a year is attached to the expression, null when none is. */
    year: boolean | null;
}

// A day token stands alone: not preceded by a digit or period (26.19 -> not day 19) and not
// followed by a digit after an optional period/colon (26.19 -> not day 26; 11:00 -> not day 11).
const DAY_TAIL = "(?![.:]?\\d)";
const ANY_MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?";
const ANY_YEAR = "(?:19|20)\\d{2}";
const ANY_DAY = "(?:0?[1-9]|[12]\\d|3[01])";
const ANY_MONTH_NUM = "(?:0?[1-9]|1[0-2])";

/** The six date-expression shapes, for a specific month/day (year captured) or for any date. */
function dateForms(monthWord: string, monthNum: string, dayNum: string, year: string): RegExp[] {
    return [
        new RegExp(`(?<![0-9.])${year}[./-]${monthNum}[./-]${dayNum}${DAY_TAIL}`, "g"),                  // 2026-09-23, 2026.09.23
        new RegExp(`(?<![0-9.])${monthNum}[./-]${dayNum}[./-]${year}${DAY_TAIL}`, "g"),                  // 09/23/2026
        new RegExp(`(?<![0-9.])${dayNum}[./-]${monthNum}[./-]${year}${DAY_TAIL}`, "g"),                  // 23.09.2026
        new RegExp(`(?<![0-9./-])${monthNum}/${dayNum}(?:/${year})?(?![0-9/])`, "g"),                    // 9/23
        new RegExp(`\\b${monthWord} ${dayNum}(?:st|nd|rd|th)?${DAY_TAIL}(?:,? ${year}\\b)?`, "g"),        // September 23(, 2026)
        new RegExp(`(?<![0-9.:])${dayNum}(?:st|nd|rd|th)? (?:of )?${monthWord}(?:,? ${year}\\b)?`, "g")  // 23 September( 2026)
    ];
}

/**
 * Every coherent mention of the value's month and day in a collapsed quote, in
 * order of position. Numeric "a/b" dates are read month-first only when that is
 * the only valid reading (a > 12 means day-first, b > 12 means month-first,
 * a == b reads the same both ways); "9/10/2026" could be September 10 or
 * October 9 and is never evidence for either.
 */
function findDateMentions(q: string, value: ParsedDateValue): DateMention[] {
    const mm = String(value.month).padStart(2, "0");
    const dd = String(value.day).padStart(2, "0");
    const mentions: DateMention[] = [];
    const add = (start: number, end: number, year: boolean | null) => {
        if (mentions.some(m => m.start < end && start < m.end)) return;
        mentions.push({ start, end, year });
    };
    // Unambiguous shapes: ISO-like year-first, and month names.
    const wordForms = [
        new RegExp(`(?<![0-9.])((?:19|20)\\d{2})[./-](?:${value.month}|${mm})[./-](?:${value.day}|${dd})${DAY_TAIL}`, "g"),
        new RegExp(`\\b${monthWordPattern(value.month)} (?:${value.day}|${dd})(?:st|nd|rd|th)?${DAY_TAIL}(?:,? ((?:19|20)\\d{2})\\b)?`, "g"),
        new RegExp(`(?<![0-9.:])(?:${value.day}|${dd})(?:st|nd|rd|th)? (?:of )?${monthWordPattern(value.month)}(?:,? ((?:19|20)\\d{2})\\b)?`, "g")
    ];
    for (const form of wordForms) {
        for (const match of q.matchAll(form)) {
            const start = match.index ?? 0;
            add(start, start + match[0].length, match[1] === undefined ? null : +match[1] === value.year);
        }
    }
    // Numeric "a/b/yyyy", "a.b.yyyy", "a-b-yyyy" and "a/b": read both ways, keep only unambiguous readings.
    const numericForms = [
        new RegExp(`(?<![0-9.])(\\d{1,2})[./-](\\d{1,2})[./-]((?:19|20)\\d{2})${DAY_TAIL}`, "g"),
        new RegExp(`(?<![0-9./-])(\\d{1,2})/(\\d{1,2})(?![0-9/])`, "g")
    ];
    for (const form of numericForms) {
        for (const match of q.matchAll(form)) {
            const a = +match[1];
            const b = +match[2];
            const readings: Array<[number, number]> = [];
            if (a <= 12 && b <= 31) readings.push([a, b]); // month/day
            if (b <= 12 && a <= 31) readings.push([b, a]); // day/month
            const distinct = readings.filter(([m, d], i) => readings.findIndex(([m2, d2]) => m2 === m && d2 === d) === i);
            if (distinct.length !== 1) continue; // ambiguous or invalid
            const [month, day] = distinct[0];
            if (month !== value.month || day !== value.day) continue;
            const start = match.index ?? 0;
            add(start, start + match[0].length, match[3] === undefined ? null : +match[3] === value.year);
        }
    }
    return mentions.sort((a, b) => a.start - b.start);
}

/** The best mention: one whose attached year matches, else one without a year, else any. */
function findDateMention(q: string, value: ParsedDateValue): DateMention | undefined {
    const mentions = findDateMentions(q, value);
    return mentions.find(m => m.year === true) ?? mentions.find(m => m.year === null) ?? mentions[0];
}

/** Spans of every date expression in a collapsed text, whatever date it names, in order of position. */
function dateExpressionSpans(q: string): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];
    for (const form of dateForms(ANY_MONTH, ANY_MONTH_NUM, ANY_DAY, ANY_YEAR)) {
        for (const match of q.matchAll(form)) {
            const start = match.index ?? 0;
            const end = start + match[0].length;
            if (!spans.some(s => s.start < end && start < s.end)) spans.push({ start, end });
        }
    }
    return spans.sort((a, b) => a.start - b.start);
}

/** Clause boundaries: ";", "|", "•", line breaks, and ". " that does not follow a month abbreviation or "a.m."/"p.m.". */
function clauseBounds(q: string, index: number): { from: number; to: number } {
    let from = 0;
    let to = q.length;
    for (const m of q.matchAll(/[;|•\n]|\. /g)) {
        const at = m.index ?? 0;
        if (m[0] === ". " && /(?:\b(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)|\b[ap]\.m|\b[a-z])$/.test(q.slice(0, at))) continue;
        if (at + m[0].length <= index) from = Math.max(from, at + m[0].length);
        else if (at >= index) to = Math.min(to, at);
    }
    return { from, to };
}

/** The collapsed quote up to its first date expression: a header that applies to every entry ("All times UTC. PC: ..."). */
export function datePreamble(quote: string): string {
    const q = collapse(quote);
    const spans = dateExpressionSpans(q);
    return spans.length > 0 ? q.slice(0, spans[0].start) : q;
}

/**
 * The part of a quote that belongs to one date: the clause containing the
 * value's date expression, cut at neighbouring date expressions. Text after the
 * date is preferred; the text before it is included only when nothing after the
 * date reads as a clock time ("at 15:00 on September 23"). Clock times and zones
 * are only evidence for the value when they occur in this segment.
 */
export function dateSegment(quote: string, value: ParsedDateValue): string | undefined {
    return dateSegments(quote, value)[0];
}

/**
 * One segment per occurrence of the value's date in the quote, in order. A quote
 * that lists several entries on the same day ("PC ... September 23 at 15:00 PT;
 * Console ... September 23 at 18:00 ET") yields one segment per entry, and the
 * caller must pick the one that names its item.
 */
export function dateSegments(quote: string, value: ParsedDateValue): string[] {
    return dateEntries(quote, value).map(e => e.segment);
}

export interface DateEntry {
    /** The part of the entry whose clock times and zones belong to the date (see dateSegment). */
    segment: string;
    /** The whole entry: the clause around the date, cut at neighbouring dates ("pc maintenance september 23 at 15:00 pt"). */
    entry: string;
    /** The collapsed quote the positions below refer to. */
    text: string;
    mentionStart: number;
    mentionEnd: number;
    clauseFrom: number;
    clauseTo: number;
}

/** Separators between list entries; a slash between digits ("26.44/45", "9/23") is not one. */
const LABEL_SEPARATOR = /[,;|•]|(?<!\d)\/|\/(?!\d)| - | – /;
const LABEL_SEPARATOR_G = new RegExp(LABEL_SEPARATOR.source, "g");

/** Words that describe, connect, categorise or date entries but never identify one. */
const NAMING_FILLER = new Set([
    "the", "and", "for", "of", "to", "in", "on", "at", "a", "an", "is", "it", "or", "by", "with", "from", "until", "till",
    "be", "will", "are", "was", "were", "this", "its",
    "patch", "patches", "update", "updates", "notes", "version", "season", "live", "maintenance", "hotfix", "release",
    "releases", "released", "downtime", "servers", "server", "schedule", "scheduled", "changelog",
    "date", "dates", "time", "times", "start", "starts", "starting", "begin", "begins", "end", "ends", "ending", "planned",
    "expected", "estimated", "posted", "published", "updated", "launch", "launches", "now", "new", "next", "tbd", "tba", "day",
    "game", "games", "news", "article", "articles", "announcement", "announcements", "blog", "post", "posts", "official", "category", "tag", "tags",
    ...MONTHS, "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun"
]);

function isLabelToken(token: string): boolean {
    if (/^\d+\.\d+$/.test(token)) return true; // a version such as 26.19
    if (/^\d/.test(token) || /^t\d/.test(token) || token.length < 2 || !/[a-z]/.test(token)) return false; // clocks, ISO "t13", "000z"
    return !NAMING_FILLER.has(token) && !(token in IANA_ALIASES) && !(token in FIXED_ALIASES);
}

interface TokenAt { token: string; start: number; end: number }

/** Word tokens with their positions, tokenised like the grounding (periods kept inside, stripped at the edges). */
function tokensAt(text: string, offset = 0): TokenAt[] {
    const out: TokenAt[] = [];
    for (const m of text.matchAll(/[a-z0-9.]+/g)) {
        const lead = m[0].length - m[0].replace(/^\.+/, "").length;
        const token = m[0].replace(/^\.+|\.+$/g, "");
        if (!token) continue;
        const startAt = offset + (m.index ?? 0) + lead;
        out.push({ token, start: startAt, end: startAt + token.length });
    }
    return out;
}

function hasForeignLabel(text: string, own: string[]): boolean {
    return tokensAt(text).some(t => isLabelToken(t.token) && !own.includes(t.token));
}

type Side = "before" | "after";

/**
 * The stretch of the clause on one side of the entry's date, stopping at another date
 * expression and, when asked, at the nearest entry separator.
 */
function sideRange(entry: DateEntry, side: Side, stopAtSeparator: boolean): [number, number] {
    const q = entry.text;
    const others = dateExpressionSpans(q).filter(s => s.end <= entry.mentionStart || s.start >= entry.mentionEnd);
    if (side === "before") {
        let from = entry.clauseFrom;
        for (const s of others) if (s.end <= entry.mentionStart && s.end > from) from = s.end;
        if (stopAtSeparator) {
            const base = from;
            for (const m of q.slice(base, entry.mentionStart).matchAll(LABEL_SEPARATOR_G)) from = base + (m.index ?? 0) + m[0].length;
        }
        return [from, entry.mentionStart];
    }
    let to = entry.clauseTo;
    for (const s of others) if (s.start >= entry.mentionEnd && s.start < to) to = s.start;
    if (stopAtSeparator) {
        const cut = q.slice(entry.mentionEnd, to).search(LABEL_SEPARATOR);
        if (cut >= 0) to = entry.mentionEnd + cut;
    }
    return [entry.mentionEnd, to];
}

/** Where a set of name tokens sits relative to the date on one side: the gap between the nearest token and the date. */
function placement(entry: DateEntry, side: Side, names: string[], stopAtSeparator: boolean): { gap: string } | undefined {
    const [from, to] = sideRange(entry, side, stopAtSeparator);
    const tokens = tokensAt(entry.text.slice(from, to), from);
    const ordered = side === "before" ? tokens.reverse() : tokens;
    const needed = new Set(names);
    let nearest: TokenAt | undefined;
    for (const token of ordered) {
        if (!needed.has(token.token)) continue;
        nearest = nearest ?? token;
        needed.delete(token.token);
        if (needed.size === 0) break;
    }
    if (!nearest || needed.size > 0) return undefined;
    const gap = side === "before" ? entry.text.slice(nearest.end, entry.mentionStart) : entry.text.slice(entry.mentionEnd, nearest.start);
    return { gap };
}

/**
 * Does this date entry belong to the item named by `discriminators`? The item's name must reach the
 * date without crossing another date. If an entry separator lies between them, the text next to the
 * date and the date's other side must not name anything else ("PC maintenance is September 23, Console
 * ... TBD" is PC's date). And no other reported item (`competitors`) may sit strictly closer on the
 * opposite side without a separator in between ("26.18 September 10 (Thursday) 26.19" is 26.18's date).
 * Names with no discriminating token cannot be told apart and always bind.
 */
export function entryBindsItem(entry: DateEntry, discriminators: string[], competitors: string[][] = []): boolean {
    const own = [...new Set(discriminators)];
    if (own.length === 0) return true;
    for (const side of ["before", "after"] as const) {
        const opposite: Side = side === "before" ? "after" : "before";
        const found = placement(entry, side, own, false);
        if (!found) continue;
        if (LABEL_SEPARATOR.test(found.gap)) {
            let adjacent: string;
            if (side === "before") {
                let cut = 0;
                for (const m of found.gap.matchAll(LABEL_SEPARATOR_G)) cut = (m.index ?? 0) + m[0].length;
                adjacent = found.gap.slice(cut);
            } else {
                adjacent = found.gap.slice(0, found.gap.search(LABEL_SEPARATOR));
            }
            if (hasForeignLabel(adjacent, own)) continue;
            const [from, to] = sideRange(entry, opposite, true);
            if (hasForeignLabel(entry.text.slice(from, to), own)) continue;
        }
        const closer = competitors.some(names => {
            const theirs = placement(entry, opposite, names, true);
            return theirs !== undefined && theirs.gap.length < found.gap.length;
        });
        if (closer) continue;
        return true;
    }
    return false;
}

/** Like dateSegments, but also returns each entry's full text so a caller can tell which entry names its item. */
export function dateEntries(quote: string, value: ParsedDateValue): DateEntry[] {
    const q = collapse(quote);
    const spans = dateExpressionSpans(q);
    const entries: DateEntry[] = [];
    for (const mention of findDateMentions(q, value)) {
        const clause = clauseBounds(q, mention.start);
        let from = clause.from;
        let to = clause.to;
        let earlierDateInClause = false;
        for (const span of spans) {
            if (span.end <= mention.start && span.end > from) {
                from = span.end;
                earlierDateInClause = true;
            }
            if (span.start >= mention.end && span.start < to) to = span.start;
        }
        const entry = q.slice(from, to).trim();
        // Clock times before the date belong to this entry ("starts at 15:00 PT on September 23 and ends
        // at 18:00 PT") unless an earlier date in the same clause claims them ("... September 23 15:00 PT
        // Patch 26.20 October 7 18:00 PT"): then only what follows the date is this entry's.
        const segment = earlierDateInClause ? q.slice(mention.start, to).trim() : entry;
        if (!entries.some(e => e.segment === segment && e.entry === entry)) {
            entries.push({ segment, entry, text: q, mentionStart: mention.start, mentionEnd: mention.end, clauseFrom: clause.from, clauseTo: clause.to });
        }
    }
    return entries;
}

/** Timezone phrases stated in a text, resolved (deduplicated by zone). */
export function zonesIn(text: string): ResolvedZone[] {
    const q = text.replace(/\s+/g, " ");
    const found: ResolvedZone[] = [];
    const push = (raw: string) => {
        const zone = resolveTimezone(raw);
        if (zone && !found.some(z => z.zone === zone.zone)) found.push(zone);
    };
    // An ISO timestamp ending in Z states UTC.
    if (/\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z\b/i.test(q)) push("utc");
    for (const m of q.matchAll(/\b(?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b/gi)) push(m[0]);
    for (const m of q.matchAll(/\b(?:[a-z]+ )?(?:[a-z]+ )?(?:standard |daylight |summer )?time\b/gi)) {
        const words = m[0].toLowerCase().split(" ");
        for (let i = 0; i < words.length - 1; i++) push(words.slice(i).join(" "));
    }
    for (const m of q.matchAll(/\b[A-Z][A-Za-z]+\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?\b/g)) push(m[0]);
    for (const m of q.matchAll(/(?<![a-z])([a-z]{2,4})(?![a-z])(?!\s*[+-]\s*\d)/gi)) {
        const word = m[1].toLowerCase();
        if (word in FIXED_ALIASES || word in IANA_ALIASES) push(word);
    }
    return found;
}

/**
 * Does the quote state the clock time claimed in a timed value?
 * Accepts 24-hour "15:00", "3 PM", "3:00 pm", "00:00", "midnight" and "noon".
 * Values without a time always pass.
 */
export function quoteMentionsTime(quote: string, value: ParsedDateValue): boolean {
    if (!value.hasTime) return true;
    const q = quote.toLowerCase();
    const hour = value.hour ?? 0;
    const minute = value.minute ?? 0;
    const second = value.second ?? 0;
    if (hour === 0 && minute === 0 && second === 0 && /\bmidnight\b/.test(q)) return true;
    if (hour === 12 && minute === 0 && second === 0 && /\bnoon\b/.test(q)) return true;

    const times = q.matchAll(/(?:^|[^0-9.])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\.\d+)?\s*(a\.?m\.?|p\.?m\.?)?(?=[^0-9]|$)/g);
    for (const m of times) {
        let h = +m[1];
        const mins = m[2] !== undefined ? +m[2] : undefined;
        const secs = m[3] !== undefined ? +m[3] : undefined;
        const meridiem = m[4]?.replace(/\./g, "");
        if (meridiem === "pm" && h < 12) h += 12;
        if (meridiem === "am" && h === 12) h = 0;
        if (mins === undefined && !meridiem) continue; // a bare number is not a time
        // Seconds count too: a value with :59 needs a quote that states :59.
        if (h === hour && (mins ?? 0) === minute && (secs ?? 0) === second) return true;
    }
    return false;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the document declares the zone for its times with a recognisable
 * declaration, not by mere co-occurrence:
 *   - a time/date/schedule noun followed by the zone in parentheses ("Scheduled Date (Pacific Time)", "Live Maintenance Schedule (UTC)")
 *   - "times/dates are|shown|listed ... in ZONE" ("All times are in PT", "Dates are listed in KST")
 *   - "ZONE time zone" / "time zone ... ZONE"
 *   - a patch/release/maintenance statement with the zone in parentheses ("Patches release on a Wednesday (PT)")
 * A zone attached to some other clock time ("Support is available 9-5 PT during
 * maintenance") or context ("Support hours are PT") does not apply to a dated event.
 */
export function zoneDeclaredIn(documentText: string, zone: ResolvedZone): boolean {
    const doc = documentText.replace(/\s+/g, " ").toLowerCase();
    for (const clause of doc.split(/[.;|•]\s+/)) {
        for (const phrase of zonePhrasesIn(clause)) {
            if (resolveTimezone(phrase)?.zone !== zone.zone) continue;
            const p = escapeRegExp(phrase.toLowerCase()).replace(/ /g, "\\s+");
            const forms = [
                new RegExp(`\\b(?:times?|dates?|schedules?|scheduled dates?|windows?|deadlines?)\\b[^()]{0,40}\\(\\s*${p}\\s*\\)`),
                new RegExp(`\\b(?:times?|dates?|schedules?|windows?)\\b[^.;]{0,60}\\b(?:are|is|listed|shown|displayed|given|provided|expressed|based|stated|quoted)\\b[^.;]{0,40}(?<![0-9:\\-–]\\s*)\\b${p}\\b`),
                new RegExp(`\\b${p}\\b\\s*(?:time ?zone)\\b|\\b(?:time ?zone)\\b[^.;]{0,20}\\b${p}\\b`),
                new RegExp(`\\b(?:patch(?:es)?|release[sd]?|updates?|maintenance|servers?|launch(?:es)?|deploy(?:s|ed|ment)?|downtime)\\b[^.;()]{0,60}\\(\\s*${p}\\s*\\)`)
            ];
            if (forms.some(f => f.test(clause))) return true;
        }
    }
    return false;
}

/** Timezone phrases in a text, as written (lower-cased), for callers that need the text rather than the zone. */
export function zonePhrasesIn(text: string): string[] {
    const q = text.replace(/\s+/g, " ").toLowerCase();
    const found: string[] = [];
    const push = (raw: string) => {
        if (resolveTimezone(raw) && !found.includes(raw)) found.push(raw);
    };
    for (const m of q.matchAll(/\b(?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b/g)) push(m[0]);
    for (const m of q.matchAll(/\b(?:[a-z]+ )?(?:[a-z]+ )?(?:standard |daylight |summer )?time\b/g)) {
        const words = m[0].split(" ");
        for (let i = 0; i < words.length - 1; i++) push(words.slice(i).join(" "));
    }
    for (const m of q.matchAll(/\b[a-z]+\/[a-z_]+(?:\/[a-z_]+)?\b/g)) push(m[0]);
    for (const m of q.matchAll(/(?<![a-z])([a-z]{2,4})(?![a-z])(?!\s*[+-]\s*\d)/g)) {
        if (m[1] in FIXED_ALIASES || m[1] in IANA_ALIASES) push(m[1]);
    }
    return found;
}

/**
 * The zone stated right after the clock that matches the value ("15:00 PT / 18:00 ET":
 * for 15:00 that is PT, for 18:00 ET). Undefined when the clock is absent or no zone
 * follows it before the next clock.
 */
export function zoneAfterClock(text: string, value: ParsedDateValue): ResolvedZone | undefined {
    if (!value.hasTime) return undefined;
    const q = text.toLowerCase();
    const wanted = ((value.hour ?? 0) * 60 + (value.minute ?? 0)) * 60 + (value.second ?? 0);
    const clocks: Array<{ start: number; end: number; seconds: number }> = [];
    for (const m of q.matchAll(/(?:^|[^0-9.])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\.\d+)?\s*(a\.?m\.?|p\.?m\.?)?(?=[^0-9]|$)/g)) {
        let h = +m[1];
        const mins = m[2] !== undefined ? +m[2] : undefined;
        const meridiem = m[4]?.replace(/\./g, "");
        if (mins === undefined && !meridiem) continue;
        if (meridiem === "pm" && h < 12) h += 12;
        if (meridiem === "am" && h === 12) h = 0;
        const lead = /^[0-9]/.test(m[0]) ? 0 : 1;
        const secs = m[3] !== undefined ? +m[3] : 0;
        clocks.push({ start: (m.index ?? 0) + lead, end: (m.index ?? 0) + m[0].length, seconds: (h * 60 + (mins ?? 0)) * 60 + secs });
    }
    const index = clocks.findIndex(c => c.seconds === wanted);
    if (index === -1) return undefined;
    const until = index + 1 < clocks.length ? clocks[index + 1].start : q.length;
    return zonesIn(q.slice(clocks[index].end, until))[0];
}

/** Clock times in the order they appear in a text, as minutes since midnight (24h or 12h with am/pm). */
export function clockTimesIn(text: string): number[] {
    const q = text.toLowerCase();
    const times: number[] = [];
    for (const m of q.matchAll(/(?:^|[^0-9.])(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=[^0-9]|$)/g)) {
        let h = +m[1];
        const mins = m[2] !== undefined ? +m[2] : undefined;
        const meridiem = m[3]?.replace(/\./g, "");
        if (mins === undefined && !meridiem) continue;
        if (h > 23 || (mins ?? 0) > 59) continue;
        if (meridiem === "pm" && h < 12) h += 12;
        if (meridiem === "am" && h === 12) h = 0;
        times.push(h * 60 + (mins ?? 0));
    }
    return times;
}
