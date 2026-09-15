/**
 * GTA Online weekly reset (recurring, computed; no network).
 *
 * Rockstar resets GTA Online weekly on Thursday at 10:00 UTC. The next reset is
 * the first Thursday 10:00:00 UTC strictly after `now`.
 *
 * Boundary rule (documented and tested): at exactly Thursday 10:00:00.000 UTC the
 * reset has just happened, so the next one is a week later. The V1 provider
 * returned the same instant for the first 60 seconds after the reset, which the
 * frontend rendered as a zero countdown; that is the one intentional difference.
 */
import { Adapter } from "../adapter";
import { dayIdentity } from "../identity";

export const GTA_RESET_WEEKDAY_UTC = 4; // Thursday
export const GTA_RESET_HOUR_UTC = 10;

export function nextWeeklyReset(now: Date): Date {
    const candidate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        GTA_RESET_HOUR_UTC, 0, 0, 0
    ));
    const daysAhead = (GTA_RESET_WEEKDAY_UTC - now.getUTCDay() + 7) % 7;
    candidate.setUTCDate(candidate.getUTCDate() + daysAhead);
    if (candidate.getTime() <= now.getTime()) {
        candidate.setUTCDate(candidate.getUTCDate() + 7);
    }
    return candidate;
}

export const gtaWeeklyResetAdapter: Adapter = async ({ now }) => {
    const next = nextWeeklyReset(now).toISOString();
    return {
        events: [{
            identity: dayIdentity(next),
            label: "Weekly reset",
            status: "scheduled",
            at: next,
            precision: "exact",
            timezone: "UTC"
        }],
        // A recurring rule: computed, never fetched or sent to a model.
        work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
    };
};
