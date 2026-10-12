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
    /**
     * When the acceptance lapses.
     *
     * An entry with no end date silences a tracker for ever, and `since` alone cannot make that visible
     * because nothing reads it (Codex, #69). After this date the outage reports again until somebody
     * looks at it and renews the entry, which is the point: an accepted outage should have to be
     * re-accepted rather than quietly outliving the reason it was accepted for.
     */
    until: string;
    /**
     * The failure this acceptance covers.
     *
     * Fortnite is accepted as *stale* -- a source that answers 403 while the store still holds a value.
     * A provider that went `unavailable` would be failing in a way nobody has looked at, and should say
     * so rather than inherit the silence.
     */
    expect: ProviderHealth["status"];
}

export const ACCEPTED_OUTAGES: readonly AcceptedOutage[] = [
    {
        game: "fortnite",
        type: "next-season",
        reason: "every official Epic property answers the publishing environment with a 403 challenge we do " +
            "not circumvent, and no permitted source states the season end. The page says so plainly and is " +
            "withheld from the index; there is nothing a run can report here that is not already known",
        since: "2026-04-05",
        // A year from the outage. If Epic is still refusing then, saying so again is cheap; if the entry
        // has outlived its reason, this is what surfaces it.
        until: "2027-04-05",
        expect: "stale"
    }
];

/**
 * Whether this provider's failure is one that has been accepted, and why.
 *
 * Three things have to line up: the tracker, the kind of failure, and the date. An acceptance that has
 * lapsed, or one for a different failure than the one happening, does not silence anything.
 */
export function acceptedOutage(game: string, type: string, status: ProviderHealth["status"], now: Date = new Date()): AcceptedOutage | undefined {
    const entry = ACCEPTED_OUTAGES.find(candidate => candidate.game === game && candidate.type === type);
    if (!entry || entry.expect !== status) return undefined;
    // Through the end of the stated day, not up to the start of it.
    //
    // `Date.parse("2027-04-05")` is midnight UTC at the beginning of that date, so comparing against it
    // directly made the acceptance lapse at 00:00 on the 5th — before the 06:00 run on the very day it
    // was supposed to still cover, and changing behaviour inside one calendar day (Codex, #69). A date
    // written in a list like this means the whole day.
    const until = Date.parse(`${entry.until}T00:00:00.000Z`);
    if (!Number.isFinite(until)) return undefined;
    const DAY_MS = 86_400_000;
    return until + DAY_MS > now.getTime() ? entry : undefined;
}

/**
 * Makes a string safe to put inside a workflow command.
 *
 * The runner reads `::warning ...` out of a step's output, so a provider's own words end up inside a
 * control line. A newline in an exception truncates the annotation, and a line beginning `::` is read
 * as another command (Codex, #69).
 *
 * It lives here rather than in refresh-all.ts, which calls main() at module load: importing the
 * helper from there started a second data refresh inside the publish step, which is the opposite of
 * what this file is for.
 */
export function escapeAnnotation(text: string): string {
    return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Degraded providers nobody has accepted — the ones worth failing a run over.
 *
 * Asked of the accepted-outage list only. An editorial decision to withhold a page is not a statement
 * that its provider is expected to fail: Roblox is withheld because a service status is not a reset, and
 * its provider works perfectly well. Reading the one as the other would silence exactly the regression
 * this exists to catch.
 */
export function unexpectedlyDegraded(health: RefreshHealth, now: Date = new Date()): ProviderHealth[] {
    return health.providers.filter(provider =>
        provider.status !== "fresh" && acceptedOutage(provider.game, provider.type, provider.status, now) === undefined);
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
