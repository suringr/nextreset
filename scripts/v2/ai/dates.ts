/**
 * Deterministic date handling for extracted facts.
 *
 * A model reports a date value and the timezone phrase it saw; this module
 * decides what that means: parse the value without touching the runner's local
 * timezone, resolve the timezone phrase to an IANA zone or a fixed offset,
 * convert to a UTC instant, and decide the precision. It also checks that a
 * quote actually mentions the date it is supposed to support.
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

const ZONE_ALIASES: Record<string, string> = {
    "utc": "UTC", "gmt": "UTC", "z": "UTC", "coordinated universal time": "UTC",
    "pt": "America/Los_Angeles", "pst": "America/Los_Angeles", "pdt": "America/Los_Angeles", "pacific": "America/Los_Angeles", "pacific time": "America/Los_Angeles", "pacific standard time": "America/Los_Angeles", "pacific daylight time": "America/Los_Angeles",
    "et": "America/New_York", "est": "America/New_York", "edt": "America/New_York", "eastern": "America/New_York", "eastern time": "America/New_York",
    "ct": "America/Chicago", "cdt": "America/Chicago", "central time": "America/Chicago",
    "mt": "America/Denver", "mst": "America/Denver", "mdt": "America/Denver", "mountain time": "America/Denver",
    "bst": "Europe/London", "uk time": "Europe/London",
    "cet": "Europe/Berlin", "cest": "Europe/Berlin", "central european time": "Europe/Berlin",
    "eet": "Europe/Athens", "eest": "Europe/Athens",
    "kst": "Asia/Seoul", "korea standard time": "Asia/Seoul",
    "jst": "Asia/Tokyo", "japan standard time": "Asia/Tokyo",
    "aest": "Australia/Sydney", "aedt": "Australia/Sydney"
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

/** Resolves a timezone phrase as a document states it. Ambiguous or unknown phrases resolve to undefined. */
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
    if (lower in ZONE_ALIASES) {
        const zone = ZONE_ALIASES[lower];
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

/** Converts a wall-clock time in a zone (IANA name or "+HH:MM" offset or "UTC") to a UTC instant. DST-safe. */
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
    /** Set when a stated time could not be converted (unknown zone): the day is kept, the time is dropped. */
    note?: string;
}

/** Turns a model-reported value + timezone phrase into an Event-compatible instant. */
export function normalizeDateFact(value: string, timezoneRaw: string | undefined): NormalizedDate | undefined {
    const parsed = parseDateValue(value);
    if (!parsed) return undefined;

    if (parsed.offsetMinutes !== undefined) {
        const wall = Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour ?? 0, parsed.minute ?? 0, parsed.second ?? 0);
        return { at: new Date(wall - parsed.offsetMinutes * 60000).toISOString(), precision: "exact", timezone: parsed.offsetMinutes === 0 ? "UTC" : `${parsed.offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(parsed.offsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(parsed.offsetMinutes) % 60).padStart(2, "0")}` };
    }

    const zone = resolveTimezone(timezoneRaw);
    if (!parsed.hasTime) {
        return { at: new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).toISOString(), precision: "day", timezone: zone?.zone };
    }
    if (!zone) {
        return {
            at: new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).toISOString(),
            precision: "day",
            note: timezoneRaw && timezoneRaw.trim() ? `timezone "${timezoneRaw.trim()}" not understood; time dropped` : "time stated without a timezone; time dropped"
        };
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
 * Day: the day number as its own token (or ordinal). Month: name/abbreviation
 * or a numeric form (m/d, mm-dd, yyyy.mm.dd, yyyy-mm-dd). Year: matching
 * four-digit year, or null when the quote states none.
 */
export function quoteMentionsDate(quote: string, value: ParsedDateValue): QuoteDateCheck {
    const q = quote.toLowerCase().replace(/\s+/g, " ");
    const mm = String(value.month).padStart(2, "0");
    const dd = String(value.day).padStart(2, "0");
    const yyyy = String(value.year);

    const numericDate = new RegExp(`(?:^|[^0-9])(?:${yyyy}[./-]${mm}[./-]${dd}|${mm}[./-]${dd}[./-]${yyyy}|${value.month}/${value.day}(?:/${yyyy})?|${dd}[./-]${mm}[./-]${yyyy}|${value.day}\\.${value.month}\\.)(?:[^0-9]|$)`);
    const numeric = numericDate.test(q);

    const monthName = MONTHS[value.month - 1];
    const monthAbbrev = monthName.slice(0, 3);
    const month = numeric || new RegExp(`\\b${monthName}\\b|\\b${monthAbbrev}\\.?\\b|\\bsept\\.?\\b`.replace("\\bsept\\.?\\b", value.month === 9 ? "\\bsept\\.?\\b" : "\\b__never__\\b")).test(q);

    const day = numeric || new RegExp(`(?:^|[^0-9:])${value.day}(?:st|nd|rd|th)?(?:[^0-9:]|$)`).test(q) || new RegExp(`(?:^|[^0-9:])${dd}(?:[^0-9:]|$)`).test(q);

    const years = q.match(/\b(19|20)\d{2}\b/g);
    const year = years ? years.includes(yyyy) : null;

    return { day, month, year };
}
