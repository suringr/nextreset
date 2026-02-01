import { ProviderResult } from "../types";

/**
 * GTA Online Weekly Reset Provider
 * 
 * GTA Online resets every Thursday at 10:00 UTC
 * This is a computed provider - no external API calls required
 */
export async function run(): Promise<ProviderResult> {
    const now = new Date();

    // Calculate next Thursday 10:00 UTC
    const nextReset = new Date(now);
    const currentDay = nextReset.getUTCDay(); // 0 = Sunday, 4 = Thursday
    const currentHour = nextReset.getUTCHours();
    const currentMinute = nextReset.getUTCMinutes();

    // Days until next Thursday
    let daysUntilThursday = (4 - currentDay + 7) % 7;

    // If today is Thursday but we've already passed 10:00 UTC, wait for next Thursday
    if (currentDay === 4 && (currentHour > 10 || (currentHour === 10 && currentMinute > 0))) {
        daysUntilThursday = 7;
    }

    // If today isn't Thursday and daysUntilThursday is 0, add 7 days
    if (daysUntilThursday === 0 && currentDay !== 4) {
        daysUntilThursday = 7;
    }

    nextReset.setUTCDate(nextReset.getUTCDate() + daysUntilThursday);
    nextReset.setUTCHours(10, 0, 0, 0);

    return {
        game: "gta",
        type: "weekly-reset",
        title: "GTA Online Weekly Reset",
        nextEventUtc: nextReset.toISOString(),
        lastUpdatedUtc: now.toISOString(),
        source: {
            name: "Rockstar Games - GTA Online Weekly Events",
            url: "https://www.rockstargames.com/gta-online"
        },
        confidence: "high",
        notes: "Weekly reset occurs every Thursday at 10:00 UTC"
    };
}
