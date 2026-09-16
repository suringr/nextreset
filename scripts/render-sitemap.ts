/**
 * Build the sitemap from the pages that actually exist, and date each one by its own facts.
 *
 * The authored sitemap listed fifteen URLs with `changefreq: daily` and a priority — two hints Google
 * has said it ignores — and no `lastmod` at all, which is the one it reads. A build-time sitemap can do
 * better, because the build knows when each page's facts last changed.
 *
 * "When the facts changed" is deliberately not "when we last checked". Every page carries a "last
 * checked" line, so a page's bytes change on every run; saying so would make every URL look modified
 * several times a day, which is exactly the unreliable `lastmod` Google learns to ignore. The date used
 * here is the newest moment the knowledge store recorded a fact the page shows: a new patch appearing,
 * a date being corrected, evidence being extracted.
 *
 * A page whose facts cannot be dated — the V1 trackers with no knowledge file, and the static pages —
 * is listed without a `lastmod` rather than with a guess. An absent date says "unknown", which is true.
 */
import * as fs from "fs";
import * as path from "path";
import { GameKnowledge, loadKnowledge, publishedEvents } from "./render-data-blocks";

export interface SitemapEntry {
    loc: string;
    /** ISO 8601, or absent where the build cannot honestly date the page. */
    lastmod?: string;
}

/** A page's URL from its place in the build: dist/lol/next-patch/index.html -> /lol/next-patch/. */
export function urlPathOf(page: string): string {
    const withoutFile = page.replace(/index\.html$/, "");
    return `/${withoutFile}`.replace(/\/{2,}/g, "/");
}

/**
 * The newest moment the store recorded a fact this page shows.
 *
 * Both halves matter: `firstSeen` dates an event appearing (a new patch on the schedule), and a claim's
 * `extractedAt` dates a value being corrected. The later of the two is when a reader would have seen
 * this page change.
 */
export function factsChangedAt(knowledge: GameKnowledge | undefined, topic: string): string | undefined {
    if (!knowledge) return undefined;
    const events = publishedEvents(knowledge.events, topic);
    if (events.length === 0) return undefined;
    const keys = new Set(events.map(event => event.key));
    const moments: string[] = [];
    // Only when a fact appeared or was stated, never when it was merely re-confirmed: lastVerified
    // moves on every successful check, and a date that moves every six hours is one Google learns to
    // ignore. An unchanged document adds no claim, so extractedAt moves only when something changed.
    for (const event of events) {
        if (event.firstSeen) moments.push(event.firstSeen);
    }
    for (const claim of knowledge.claims ?? []) {
        if (keys.has(claim.eventKey) && claim.extractedAt) moments.push(claim.extractedAt);
    }
    const newest = moments.filter(m => Number.isFinite(Date.parse(m))).sort().pop();
    return newest ? new Date(newest).toISOString() : undefined;
}

export function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/** The sitemap document. Only `loc` and `lastmod`: the other two hints are not read. */
export function buildSitemap(entries: SitemapEntry[]): string {
    const urls = entries.map(entry => {
        const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : "";
        return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export interface SitemapInput {
    /** Page path within the build, e.g. "lol/next-patch/index.html". */
    page: string;
    /** The tracker the page shows, where it has one. */
    tracker?: { game: string; type: string };
    /**
     * Whether this URL is submitted.
     *
     * A page carrying `noindex` is not, but its facts still belong to the homepage, which renders its
     * card either way. Leaving it out of the calculation entirely would let the homepage's date go
     * stale behind a value it is showing.
     */
    listed?: boolean;
}

/**
 * Orders and dates every page.
 *
 * The homepage carries the values of every tracker, so its facts are as new as the newest of them.
 */
export function sitemapEntries(pages: SitemapInput[], origin: string, knowledgeFor: (game: string) => GameKnowledge | undefined): SitemapEntry[] {
    const entries: SitemapEntry[] = [];
    let newest: string | undefined;

    for (const { page, tracker, listed } of pages) {
        const loc = `${origin}${urlPathOf(page)}`;
        if (!tracker) {
            if (listed !== false) entries.push({ loc });
            continue;
        }
        const lastmod = factsChangedAt(knowledgeFor(tracker.game), tracker.type);
        // The homepage shows every tracker's card, so every tracker's facts date it — including those of
        // a page that is not itself submitted.
        if (lastmod && (!newest || lastmod > newest)) newest = lastmod;
        if (listed === false) continue;
        entries.push(lastmod ? { loc, lastmod } : { loc });
    }

    const home = entries.find(entry => entry.loc === `${origin}/`);
    if (home && newest) home.lastmod = newest;

    // The homepage first, then by URL: a stable order, so a rebuild that changed nothing produces the
    // same file.
    return entries.sort((a, b) => {
        if (a.loc === `${origin}/`) return -1;
        if (b.loc === `${origin}/`) return 1;
        return a.loc.localeCompare(b.loc);
    });
}

/** Writes dist/sitemap.xml. Returns what it wrote, for the build log and for tests. */
export function renderSitemap(distDir: string, root: string, pages: SitemapInput[], origin = "https://nextreset.co"): SitemapEntry[] {
    const cache = new Map<string, GameKnowledge | undefined>();
    const knowledgeFor = (game: string) => {
        if (!cache.has(game)) cache.set(game, loadKnowledge(root, game));
        return cache.get(game);
    };
    const entries = sitemapEntries(pages, origin, knowledgeFor);
    fs.writeFileSync(path.join(distDir, "sitemap.xml"), buildSitemap(entries), "utf8");
    return entries;
}
