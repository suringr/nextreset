/**
 * Fortnite Next Season Provider
 * 
 * Fetches season end date from Epic Games Help Center
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "fortnite",
    game: "fortnite",
    type: "next-season",
    title: "Fortnite Next Season"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://www.epicgames.com/help/en-US/fortnite-c5719335176219/battle-royale-c5719350646299/when-does-the-current-fortnite-season-end-a5720184470299";

    try {
        const response = await fetchHtml(url, { useBrowserOnBlocked: true });

        if (!response.ok) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                response.failureType || FailureType.Unavailable,
                response.error || `HTTP ${response.status}`,
                lastGood,
                response.status,
                response.mode
            );
        }

        const $ = cheerio.load(response.text);
        // Clean up: remove scripts and styles that might interfere with text extraction
        $("script, style, noscript").remove();

        const finalSourceUrl = response.url || url;
        // Broaden target text to entire body if structured elements not found
        const bodyText = $("article, .article-body, main, #main-content").text() || $("body").text();

        const datePatterns = [
            /ends?\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
            /until\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
            /([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/
        ];

        let seasonEndDate: Date | null = null;
        const now = new Date();

        for (const pattern of datePatterns) {
            const match = bodyText.match(pattern);
            if (match) {
                const parsedDate = new Date(match[1]);
                if (!isNaN(parsedDate.getTime())) {
                    // Date Validation Guardrail
                    const twoYearsAgo = new Date();
                    twoYearsAgo.setFullYear(now.getFullYear() - 2);
                    const twoYearsFuture = new Date();
                    twoYearsFuture.setFullYear(now.getFullYear() + 2);

                    if (parsedDate > now && parsedDate <= twoYearsFuture) {
                        seasonEndDate = parsedDate;
                        break;
                    }
                }
            }
        }

        if (!seasonEndDate) {
            console.log(`[Fortnite] no explicit date exists in HTML at ${finalSourceUrl}`);
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "Could not extract explicit season end date from Fortnite help article",
                lastGood,
                response.status,
                response.mode
            );
        }

        return {
            ...META,
            status: "fresh",
            nextEventUtc: seasonEndDate.toISOString(),
            fetched_at_utc: now.toISOString(),
            source_url: finalSourceUrl,
            confidence: Confidence.Medium,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: "Season end date may change"
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
