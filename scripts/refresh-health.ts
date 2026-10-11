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
 * red while Fortnite is unreachable, and an alarm that is always on is an alarm nobody reads.
 *
 * The first version of this keyed on `EDITORIAL_NOINDEX`, reusing a decision about *indexing* to mean
 * *this outage is expected*. Those two coincide for Fortnite and nowhere else. Roblox is withheld
 * because a service status is not a reset and status.roblox.com answers it first-hand -- nothing to do
 * with whether its provider works -- so a real Roblox regression would have left every run green
 * indefinitely (Codex, #69).
 *
 * They are separate lists now, because they are separate judgements.
 */
import * as fs from "fs";
import * as path from "path";

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

/**
 * Outages someone has looked at and accepted, so a run that reports them is not a run worth failing.
 *
 * Deliberately a short list with a reason and a date against each, and deliberately not inferred from
 * anything else. An entry here says "we know, we expect this today, stop telling us" -- which is a claim
 * about the provider, not about the page, and is the only claim that should be able to silence an alarm.
 *
 * Removing an entry is how a topic starts being reported again, and that is meant to be a deliberate
 * edit by someone who has decided the outage is no longer expected.
 */
export interface AcceptedOutage {
    game: string;
    type: string;
    /** Why this one is expected, for whoever reads the list next. */
    reason: string;
    /** When it was accepted, so a stale entry is visible as a stale entry. */
    since: string;
}

export const ACCEPTED_OUTAGES: readonly AcceptedOutage[] = [
    {
        game: "fortnite",
        type: "next-season",
        reason: "every official Epic property answers the publishing environment with a 403 challenge we do " +
            "not circumvent, and no permitted source states the season end. The page says so plainly and is " +
            "withheld from the index; there is nothing a run can report here that is not already known",
        since: "2026-04-05"
    }
];

/** Whether this provider's failure is one that has been accepted, and why. */
export function acceptedOutage(game: string, type: string): AcceptedOutage | undefined {
    return ACCEPTED_OUTAGES.find(entry => entry.game === game && entry.type === type);
}

/**
 * Degraded providers nobody has accepted — the ones worth failing a run over.
 *
 * Asked of the accepted-outage list only. An editorial decision to withhold a page is not a statement
 * that its provider is expected to fail: Roblox is withheld because a service status is not a reset, and
 * its provider works perfectly well. Reading the one as the other would silence exactly the regression
 * this exists to catch.
 */
export function unexpectedlyDegraded(health: RefreshHealth): ProviderHealth[] {
    return health.providers.filter(provider =>
        provider.status !== "fresh" && acceptedOutage(provider.game, provider.type) === undefined);
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
