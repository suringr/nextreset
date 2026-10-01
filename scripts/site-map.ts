/**
 * Every page the site publishes, declared once.
 *
 * Three test files used to describe the shape of the site with literals: "expected 17 authored pages",
 * "expected 12 tracker pages", "expected every authored page, found >= 15". The literals were there for
 * a good reason — without them a page could be added and the coverage tests would pass by never looking
 * at it — but they meant that adding a single page was a three-file renumbering exercise, and that two
 * unrelated pieces of work could not be in flight at once without colliding on the same three numbers.
 *
 * This module keeps the property and drops the arithmetic. The manifest below is the contract: adding a
 * page to the site means adding one entry here, and a page on disk with no entry (or an entry with no
 * page) is a test failure rather than a silent gap in coverage. The tests ask the manifest how many
 * pages there should be instead of being told.
 *
 * It is a declaration, not a scan. A scan would describe whatever happens to be in `public/` — including
 * a page somebody forgot to finish — and could never fail. `matchesDirectory` is what turns the
 * declaration back into a check.
 *
 * Nothing here fetches, renders or writes. It is read by the tests, by the footer navigation, and by the
 * indexing rules; it costs the build nothing.
 */
import * as fs from "fs";
import * as path from "path";

/**
 * What a page is, for the rules that treat whole classes of page alike.
 *
 * The same four kinds `design/tokens.ts` splits pages into for critical CSS, named here because the
 * manifest has to say which is which before a file exists to inspect.
 */
export type PageRole = "home" | "tracker" | "play" | "static" | "not-found";

export interface SitePage {
    /** The path within the build, exactly as the renderer names it: "lol/next-patch/index.html". */
    page: string;
    role: PageRole;
    /** The tracker this page publishes, for a tracker page and nothing else. */
    tracker?: { game: string; type: string };
}

/**
 * The site.
 *
 * Ordered as a reader meets it: the homepage, the trackers, the arcade, the pages that explain the site,
 * and the page for a URL that is not one. A tracker's `game` and `type` are the same pair
 * `update-game-pages.ts` names and the same pair the published data file is keyed by, so a typo here
 * fails a test rather than publishing a page with no data behind it.
 */
export const SITE_PAGES: readonly SitePage[] = [
    { page: "index.html", role: "home" },

    { page: "cs2/last-update/index.html", role: "tracker", tracker: { game: "cs2", type: "last-update" } },
    { page: "ea-sports-fc/last-title-update/index.html", role: "tracker", tracker: { game: "ea-sports-fc", type: "last-title-update" } },
    { page: "fortnite/next-season/index.html", role: "tracker", tracker: { game: "fortnite", type: "next-season" } },
    { page: "genshin/next-banner/index.html", role: "tracker", tracker: { game: "genshin", type: "next-banner" } },
    { page: "gta/weekly-reset/index.html", role: "tracker", tracker: { game: "gta", type: "weekly-reset" } },
    { page: "lol/next-patch/index.html", role: "tracker", tracker: { game: "lol", type: "next-patch" } },
    { page: "minecraft/last-release/index.html", role: "tracker", tracker: { game: "minecraft", type: "last-release" } },
    { page: "pubg/last-patch/index.html", role: "tracker", tracker: { game: "pubg", type: "last-patch" } },
    { page: "red-dead-redemption-2/last-update/index.html", role: "tracker", tracker: { game: "red-dead-redemption-2", type: "last-update" } },
    { page: "roblox/status/index.html", role: "tracker", tracker: { game: "roblox", type: "status" } },
    { page: "valorant/last-patch/index.html", role: "tracker", tracker: { game: "valorant", type: "last-patch" } },
    { page: "warzone/last-patch/index.html", role: "tracker", tracker: { game: "warzone", type: "last-patch" } },

    { page: "play/index.html", role: "play" },

    { page: "about/index.html", role: "static" },
    { page: "privacy/index.html", role: "static" },

    { page: "404.html", role: "not-found" }
];

/** Every page of a given role, in manifest order. */
export function pagesWithRole(role: PageRole): SitePage[] {
    return SITE_PAGES.filter(entry => entry.role === role);
}

/** The tracker pages, in manifest order. */
export function trackerPages(): SitePage[] {
    return pagesWithRole("tracker");
}

/** Every page's path, sorted, which is the order a directory walk produces. */
export function pagePaths(): string[] {
    return SITE_PAGES.map(entry => entry.page).sort();
}

/** The manifest entry for a page, or undefined where the manifest does not know it. */
export function pageEntry(page: string): SitePage | undefined {
    return SITE_PAGES.find(entry => entry.page === page);
}

export interface DirectoryMatch {
    /** Pages on disk that the manifest does not declare. */
    undeclared: string[];
    /** Pages the manifest declares that are not on disk. */
    missing: string[];
}

/**
 * Compares the manifest against a directory of authored or built pages.
 *
 * This is the half that makes the manifest a contract rather than a comment. A new page that nobody
 * declared shows up as `undeclared`; an entry whose file was deleted or moved shows up as `missing`.
 * Either one fails the test that calls this, which is the behaviour the literal counts used to provide.
 */
export function matchesDirectory(dir: string): DirectoryMatch {
    const found: string[] = [];
    const walk = (at: string) => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) found.push(path.relative(dir, full).split(path.sep).join("/"));
        }
    };
    walk(dir);
    const declared = new Set(SITE_PAGES.map(entry => entry.page));
    return {
        undeclared: found.filter(page => !declared.has(page)).sort(),
        missing: SITE_PAGES.map(entry => entry.page).filter(page => !found.includes(page)).sort()
    };
}
