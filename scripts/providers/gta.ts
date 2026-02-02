/**
 * GTA Online Weekly Reset Provider
 * 
 * GTA Online resets every Thursday at 10:00 UTC
 * This is a computed provider - no external API calls required
 */

import { ProviderResult, ProviderMeta } from "../types";

const META: ProviderMeta = {
    game: "gta",
    type: "weekly-reset",
    title: "GTA Online Weekly Reset"
};

export async function run(): Promise<ProviderResult> {
    try {
        const now = new Date();

        // Calculate next Thursday 10:00 UTC
        const nextReset = new Date(now);
        const currentDay = nextReset.getUTCDay();
        const currentHour = nextReset.getUTCHours();
        const currentMinute = nextReset.getUTCMinutes();

        let daysUntilThursday = (4 - currentDay + 7) % 7;

        if (currentDay === 4 && (currentHour > 10 || (currentHour === 10 && currentMinute > 0))) {
            daysUntilThursday = 7;
        }

        if (daysUntilThursday === 0 && currentDay !== 4) {
            daysUntilThursday = 7;
        }

        nextReset.setUTCDate(nextReset.getUTCDate() + daysUntilThursday);
        nextReset.setUTCHours(10, 0, 0, 0);

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: nextReset.toISOString(),
            lastUpdatedUtc: now.toISOString(),
            source: {
                name: "Rockstar Games - GTA Online Weekly Events",
                url: "https://www.rockstargames.com/gta-online"
            },
            confidence: "high",
            status: "ok",
            notes: "Weekly reset occurs every Thursday at 10:00 UTC"
        };
    } catch (error) {
        // This should never fail, but just in case
        const reason = error instanceof Error ? error.message : String(error);
        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: null,
            lastUpdatedUtc: new Date().toISOString(),
            source: null,
            confidence: "none",
            status: "unavailable",
            reason
        };
    }
}
