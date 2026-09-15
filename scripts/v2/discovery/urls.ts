/**
 * URL normalization and classification for discovery.
 *
 * Search results and page links arrive in many spellings of the same page
 * (tracking parameters, fragments, trailing slashes, http/https, locale
 * variants). Everything downstream works on canonical URLs and on the
 * "official" / "secondary" tier derived from the game's official domains.
 */

/** Query parameters that only track the visitor; dropped when canonicalizing. */
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|cmpid|s_kwcid|sc_channel)$/i;

/** Two-letter language codes accepted as a locale path segment on their own ("/de/..."). */
const LANGUAGES = new Set([
    "en", "de", "fr", "es", "it", "pt", "ja", "ko", "zh", "ru", "pl", "tr", "th", "vi", "id", "ms",
    "ar", "cs", "hu", "ro", "el", "nl", "sv", "da", "fi", "no", "uk", "bg", "hr", "sk", "sl", "lt", "lv", "et"
]);

const LOCALE_SEGMENT = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i;

/** Hostname without a leading "www.", lower-cased; "" for unparsable input. */
export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}

/** "https://WWW.Example.com/Path/" -> "example.com" style domain from a domain or URL string. */
export function normalizeDomain(domain: string): string {
    return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/:].*$/, "");
}

/**
 * Canonical form of an http(s) URL: lower-case host, no fragment, no default
 * port, tracking parameters removed, remaining parameters sorted, duplicate and
 * trailing slashes removed. Returns undefined for anything that is not http(s).
 */
export function canonicalUrl(raw: string, base?: string): string | undefined {
    let u: URL;
    try {
        u = new URL(raw.trim(), base);
    } catch {
        return undefined;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    u.username = "";
    u.password = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    const params = [...u.searchParams.entries()]
        .filter(([key]) => !TRACKING_PARAM.test(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = "";
    for (const [key, value] of params) u.searchParams.append(key, value);
    let pathname = u.pathname.replace(/\/{2,}/g, "/");
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
    u.pathname = pathname;
    return u.toString();
}

/** Identity of a page regardless of scheme and "www.": used to merge duplicates. */
export function dedupeKey(url: string): string {
    const u = new URL(url);
    return `${hostOf(url)}${u.pathname}${u.search}`;
}

function isLocaleToken(token: string): boolean {
    const m = LOCALE_SEGMENT.exec(token);
    if (!m) return false;
    return LANGUAGES.has(m[1].toLowerCase()) && (m[2] !== undefined || token.length === 2);
}

/**
 * The locale a URL is addressed in, when one of its first two path segments is
 * a locale ("/en-us/...", "/hc/de-de/articles/...") or a lang/locale/hl query
 * parameter says so. Lower-case "xx" or "xx-yy"; undefined when none.
 */
export function localeOf(url: string): string | undefined {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return undefined;
    }
    const segments = u.pathname.split("/").filter(Boolean).slice(0, 2);
    for (const segment of segments) {
        if (isLocaleToken(segment)) return segment.toLowerCase().replace("_", "-");
    }
    for (const key of ["lang", "locale", "hl"]) {
        const value = u.searchParams.get(key);
        if (value && isLocaleToken(value)) return value.toLowerCase().replace("_", "-");
    }
    return undefined;
}

export function isEnglishLocale(locale: string | undefined): boolean {
    return locale === undefined || locale.startsWith("en");
}

/** Identity of a page across its locale variants ("/de-de/x" and "/en-us/x" share a key). */
export function localeAgnosticKey(url: string): string {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    for (let i = 0; i < Math.min(2, segments.length); i++) {
        if (isLocaleToken(segments[i])) {
            segments.splice(i, 1);
            break;
        }
    }
    for (const key of ["lang", "locale", "hl"]) u.searchParams.delete(key);
    return `${hostOf(url)}/${segments.join("/")}${u.search}`;
}

/** True when the URL's host is one of the domains or a subdomain of one of them. */
export function isOfficialUrl(url: string, officialDomains: string[]): boolean {
    const host = hostOf(url);
    if (!host) return false;
    return officialDomains.map(normalizeDomain).some(domain => domain.length > 0 && (host === domain || host.endsWith(`.${domain}`)));
}

/** The official domain (from the list) that a URL belongs to, if any. */
export function officialDomainOf(url: string, officialDomains: string[]): string | undefined {
    const host = hostOf(url);
    return officialDomains.map(normalizeDomain).find(domain => domain.length > 0 && (host === domain || host.endsWith(`.${domain}`)));
}

function safeDecode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

/** Words of a URL path and query, lower-cased ("/en-us/patch-schedule-league-of-legends" -> [en, us, patch, schedule, ...]). */
export function slugTokens(url: string): string[] {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return [];
    }
    // Result and sitemap URLs are external input: a malformed escape is tokenized as written, never fatal.
    return `${safeDecode(u.pathname)} ${safeDecode(u.search)}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length > 0);
}

const BINARY_EXTENSION = /\.(pdf|zip|rar|7z|exe|dmg|pkg|msi|apk|png|jpe?g|gif|webp|svg|mp4|mp3|webm|avi|mov|css|js|json|xml|rss|ico|woff2?|ttf)$/i;
const NON_CONTENT_PATH = /\/(login|signin|sign-in|signup|sign-up|register|account|cart|checkout|search|logout)(\/|$)/i;

/** Cheap deterministic rejection of URLs that cannot be a content page. */
export function contentUrlProblem(url: string): string | undefined {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return "not a URL";
    }
    if (BINARY_EXTENSION.test(u.pathname)) return "not an HTML page";
    if (NON_CONTENT_PATH.test(u.pathname)) return "account or search page";
    return undefined;
}
