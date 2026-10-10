/**
 * What the refresh managed this run, and whether anyone should be told.
 *
 * `build:site` used to swallow the refresh with `|| true`. Publishing the rest of the site when a
 * provider fails is right — the pages are static, the arcade works, the trackers that still have stored
 * values still answer, and the ones that do not say so honestly. Throwing all of that away because one
 * fetch failed would be worse for every visitor.
 *
 * What was wrong is that `|| true` also discarded the fact that it happened.
 *
 * Replacing it with "fail the run when the refresh exits non-zero" fixed less than it looked like it
 * did. `refresh-all` exits non-zero only when more than half of all providers are unavailable, and a
 * *stale* provider never counts towards that at all — so the exact incident that motivated this work,
 * Fortnite serving last-known-good data from 2026-04-05 for six months, would still have left every run
 * green (Codex, #69). A degradation alarm that cannot see the degradation it was built for is worse than
 * none, because it looks like coverage.
 *
 * So health is recorded per provider, from the results, rather than inferred from one process exit code.
 *
 * Which of them should turn the run red is the other half. "Any provider not fresh" would mean permanent
 * red while Fortnite is unreachable, and an alarm that is always on is an alarm nobody reads. The site
 * already records which topics are known to be stopped, in `EDITORIAL_NOINDEX`, and those are deliberate
 * written-down decisions rather than a threshold invented here. A provider degrading while its page is
 * editorially withheld is the situation someone already looked at and accepted. A provider degrading
 * while its page is still in the index is news.
 */
import * as fs from "fs";
import * as path from "path";
import { editorialNoindex } from "./indexing";
import { trackerPages } from "./site-map";

const BUILD = path.resolve(__dirname, "..", "build");
export const FAILED_MARKER = path.join(BUILD, "refresh.failed");
export const HEALTH_FILE = path.join(BUILD, "refresh.health.json");

export interface ProviderHealth {
    game: string;
    type: string;
    status: "fresh" | "stale" | "unavailable";
    /** Why it is not fresh, as the provider explained it. */
    detail?: string;
}

export interface RefreshHealth {
    at: string;
    providers: ProviderHealth[];
}

/** The page a tracker publishes to, or undefined where the manifest does not know it. */
function pageOf(game: string, type: string): string | undefined {
    return trackerPages().find(entry => entry.tracker?.game === game && entry.tracker?.type === type)?.page;
}

/**
 * Degraded providers whose pages are still in the index — the ones nobody has decided to accept.
 *
 * A provider that is failing while its page is editorially withheld is a known stop; one that is failing
 * while its page is still offered to readers is a regression.
 */
export function unexpectedlyDegraded(health: RefreshHealth): ProviderHealth[] {
    return health.providers.filter(provider => {
        if (provider.status === "fresh") return false;
        const page = pageOf(provider.game, provider.type);
        // A tracker the manifest does not know about has no accepted-stop decision behind it, so it counts.
        return page === undefined || editorialNoindex(page) === undefined;
    });
}

export function writeHealth(providers: ProviderHealth[], at: Date = new Date()): void {
    fs.mkdirSync(BUILD, { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({ at: at.toISOString(), providers } satisfies RefreshHealth, null, 2) + "\n", "utf8");
}

export function readHealth(): RefreshHealth | undefined {
    if (!fs.existsSync(HEALTH_FILE)) return undefined;
    try {
        return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8")) as RefreshHealth;
    } catch {
        return undefined;
    }
}

/** The refresh did not finish at all. Distinct from "some providers failed", which `writeHealth` records. */
export function markRefreshFailed(at: Date = new Date()): void {
    fs.mkdirSync(BUILD, { recursive: true });
    fs.writeFileSync(FAILED_MARKER, `${at.toISOString()}\n`, "utf8");
}

/** Cleared at the start of every refresh, so both files always describe this run and never an older one. */
export function clearRefreshHealth(): void {
    for (const file of [FAILED_MARKER, HEALTH_FILE]) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
}

if (require.main === module) {
    markRefreshFailed();
    // Deliberately exit 0: this runs as the `||` branch of the refresh, and a non-zero exit here would
    // break the chain and stop the site publishing at all, which is the opposite of the intent.
    console.warn("::warning title=Data refresh::the refresh did not finish; publishing last known good values");
}
