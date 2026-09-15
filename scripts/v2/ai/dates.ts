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

/** Converts a wall-clock time in a zone (IANA name, "+HH:MM" offset, or "UTC") to a UTC instant. DST-safe. */
export function zonedToUtc(value: ParsedDateValue, zone: string): Date {
    const wall = Date.UTC(value.year, value.month - 1, value.day, value.hour ?? 0, value.minute ?? 0, value.second ?? 0);
    if (zone === "UTC") return new Date(wall);
    const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
    if (fixed) {
        const minutes = (fixed[1] === "-" ? -1 : 1) * (+fixed[2] * 60 + +fixed[3]);
        return new Date(wall - minutes * 60000);
    }
    let guess = wall - tzOffsetMinutes(zone, new Date(wall)) * 60000;
    guess = wall - tzOffsetMinutes(zone, new Date(guess)) * 60000;
    return new Date(guess);
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
    return { at: zonedToUtc(parsed, zone.zone).toISOString(), precision: "exact", timezone: zone.zone };
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
 * Day: the day number as its own token (or ordinal), never a component of a
 * decimal/version number such as "26.19". Month: name/abbreviation or a
 * numeric date form (yyyy-mm-dd, yyyy.mm.dd, mm/dd/yyyy, m/d, dd-mm-yyyy).
 * Year: matching four-digit year, or null when the quote states none.
 */
export function quoteMentionsDate(quote: string, value: ParsedDateValue): QuoteDateCheck {
    const q = quote.toLowerCase().replace(/\s+/g, " ");
    const mm = String(value.month).padStart(2, "0");
    const dd = String(value.day).padStart(2, "0");
    const yyyy = String(value.year);

    const numericDate = new RegExp(
        `(?:^|[^0-9.])(?:${yyyy}[./-]${mm}[./-]${dd}|${mm}[./-]${dd}[./-]${yyyy}|${value.month}/${value.day}(?:/${yyyy})?|${dd}[./-]${mm}[./-]${yyyy})(?:[^0-9.]|$)`
    );
    const numeric = numericDate.test(q);

    const monthName = MONTHS[value.month - 1];
    const monthPattern = value.month === 9
        ? `\\b(?:september|sept?\\.?)\\b`
        : `\\b(?:${monthName}|${monthName.slice(0, 3)}\\.?)\\b`;
    const month = numeric || new RegExp(monthPattern).test(q);

    // A day token must stand alone: not preceded by a digit or a period (26.19 -> not day 19),
    // not followed by a digit after an optional period/colon (26.19 -> not day 26; 11:00 -> not day 11).
    const dayPattern = `(?:^|[^0-9.:])(?:${value.day}|${dd})(?:st|nd|rd|th)?(?![.:]?\\d)(?=[^0-9]|$)`;
    const day = numeric || new RegExp(dayPattern).test(q);

    const years = q.match(/\b(19|20)\d{2}\b/g);
    const year = years ? years.includes(yyyy) : null;

    return { day, month, year };
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
    if (hour === 0 && minute === 0 && /\bmidnight\b/.test(q)) return true;
    if (hour === 12 && minute === 0 && /\bnoon\b/.test(q)) return true;

    const times = q.matchAll(/(?:^|[^0-9.])(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=[^0-9]|$)/g);
    for (const m of times) {
        let h = +m[1];
        const mins = m[2] !== undefined ? +m[2] : undefined;
        const meridiem = m[3]?.replace(/\./g, "");
        if (meridiem === "pm" && h < 12) h += 12;
        if (meridiem === "am" && h === 12) h = 0;
        if (mins === undefined && !meridiem) continue; // a bare number is not a time
        if (h === hour && (mins ?? 0) === minute) return true;
    }
    return false;
}

/** True when the document states the timezone phrase somewhere (or the quote carries an ISO "Z" for UTC). */
export function timezoneMentioned(documentText: string, quote: string, timezoneRaw: string | undefined): boolean {
    if (!timezoneRaw || timezoneRaw.trim().length === 0) return false;
    const phrase = timezoneRaw.trim().replace(/[()]/g, "").replace(/\s+/g, " ").toLowerCase();
    const doc = documentText.replace(/\s+/g, " ").toLowerCase();
    if (doc.includes(phrase)) return true;
    const resolved = resolveTimezone(timezoneRaw);
    if (resolved?.zone === "UTC" && /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z\b/i.test(quote)) return true;
    return false;
}
