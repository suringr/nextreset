/**
 * Fortnite Next Season Provider
 * 
 * Fetches season end date from Epic Games Help Center
 */

import * as cheerio from "cheerio";
import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
    game: "fortnite",
    type: "next-season",
    title: "Fortnite Next Season"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://www.epicgames.com/help/en-US/fortnite-c5719335176219/battle-royale-c5719350646299/when-does-the-current-fortnite-season-end-a5720184470299";

    try {
        const response = await fetchWithRetry(url);

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch Fortnite help article: ${reason}`, lastGood);
        }

        const $ = cheerio.load(response.text);
        const bodyText = $("article, .article-body, main").text();

        const datePatterns = [
            /ends?\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
            /until\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
            /([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/
        ];

        let seasonEndDate: Date | null = null;

        for (const pattern of datePatterns) {
            const match = bodyText.match(pattern);
            if (match) {
                const parsedDate = new Date(match[1]);
                if (!isNaN(parsedDate.getTime()) && parsedDate > new Date()) {
                    seasonEndDate = parsedDate;
                    break;
                }
            }
        }

        if (!seasonEndDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "Could not extract season end date from Fortnite help article", lastGood);
        }

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: seasonEndDate.toISOString(),
            lastUpdatedUtc: new Date().toISOString(),
            source: {
                name: "Epic Games Help Center",
                url: url
            },
            confidence: "medium",
            status: "ok",
            notes: "Season end date may change"
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
