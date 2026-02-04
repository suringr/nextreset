/**
 * GTA Online Weekly Reset Provider
 * 
 * GTA Online resets every Thursday at 10:00 UTC
 * This is a computed provider - no external API calls required
 */

import { Confidence, ProviderResult, ProviderMetadata } from "../types";

const META: ProviderMetadata = {
    provider_id: "gta",
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
            ...META,
            status: "fresh",
            nextEventUtc: nextReset.toISOString(),
            fetched_at_utc: now.toISOString(),
            last_success_at_utc: now.toISOString(),
            source_url: "https://www.rockstargames.com/gta-online",
            confidence: Confidence.High,
            notes: "Weekly reset occurs every Thursday at 10:00 UTC"
        };
    } catch (error) {
        throw error;
    }
}
