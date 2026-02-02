/**
 * League of Legends Next Patch Provider
 * 
 * Fetches next patch date from Riot's official patch schedule
 */

import * as cheerio from "cheerio";
import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
    game: "lol",
    type: "next-patch",
    title: "League of Legends Next Patch"
};

interface PatchInfo {
    date: Date;
    patchName: string;
}

export async function run(): Promise<ProviderResult> {
    const url = "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/360018987893-League-of-Legends-Patch-Schedule";

    try {
        const response = await fetchWithRetry(url);

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch LoL patch schedule: ${reason}`, lastGood);
        }

        const $ = cheerio.load(response.text);
        const now = new Date();

        // Find best patch (closest future date)
        let bestPatch: PatchInfo | null = null;

        $("table tr, li, p").each((_, elem) => {
            const text = $(elem).text();
            const patchMatch = text.match(/Patch\s+(\d+\.\d+)/i);
            const dateMatch = text.match(/([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/);

            if (patchMatch && dateMatch) {
                const dateStr = dateMatch[1];
                let parsedDate = new Date(dateStr);

                if (isNaN(parsedDate.getTime())) {
                    parsedDate = new Date(`${dateStr}, ${now.getFullYear()}`);
                }
                if (isNaN(parsedDate.getTime())) {
                    parsedDate = new Date(`${dateStr}, ${now.getFullYear() + 1}`);
                }

                if (parsedDate > now && (!bestPatch || parsedDate < bestPatch.date)) {
                    bestPatch = { date: parsedDate, patchName: patchMatch[1] };
                }
            }
        });

        if (!bestPatch) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "Could not find next patch date in LoL patch schedule", lastGood);
        }

        // TypeScript needs explicit access after null check with callbacks
        const result: PatchInfo = bestPatch;

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: result.date.toISOString(),
            lastUpdatedUtc: now.toISOString(),
            source: {
                name: "Riot Games - LoL Patch Schedule",
                url: url
            },
            confidence: "high",
            status: "ok",
            notes: result.patchName ? `Patch ${result.patchName}` : undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
