import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ProviderResult } from "../types";

/**
 * League of Legends Next Patch Provider
 * 
 * Fetches next patch date from Riot's official patch schedule
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/360018987893-League-of-Legends-Patch-Schedule";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch LoL patch schedule: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const now = new Date();
    const result: { date: Date; patchName: string } | null = (() => {
        let best: { date: Date; patchName: string } | null = null;

        // Look for table rows or list items containing patch dates
        $("table tr, li, p").each((_, elem) => {
            const text = $(elem).text();

            // Look for patterns like "Patch 14.1" and dates
            const patchMatch = text.match(/Patch\s+(\d+\.\d+)/i);
            const dateMatch = text.match(/([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/);

            if (patchMatch && dateMatch) {
                const dateStr = dateMatch[1];

                // Parse date (may need current year if not included)
                let parsedDate = new Date(dateStr);

                // If year not included, try adding current year
                if (isNaN(parsedDate.getTime())) {
                    parsedDate = new Date(`${dateStr}, ${now.getFullYear()}`);
                }

                // If still invalid, try next year
                if (isNaN(parsedDate.getTime())) {
                    parsedDate = new Date(`${dateStr}, ${now.getFullYear() + 1}`);
                }

                // Check if this is a future date
                if (parsedDate > now && (!best || parsedDate < best.date)) {
                    best = { date: parsedDate, patchName: patchMatch[1] };
                }
            }
        });

        return best;
    })();

    if (!result) {
        throw new Error("Could not find next patch date in LoL patch schedule");
    }

    // Type assertion to help TypeScript narrow the type after null check
    const patchData = result as { date: Date; patchName: string };

    return {
        game: "lol",
        type: "next-patch",
        title: "League of Legends Next Patch",
        nextEventUtc: patchData.date.toISOString(),
        lastUpdatedUtc: now.toISOString(),
        source: {
            name: "Riot Games - LoL Patch Schedule",
            url: url
        },
        confidence: "high",
        notes: patchData.patchName ? `Patch ${patchData.patchName}` : undefined
    };
}
