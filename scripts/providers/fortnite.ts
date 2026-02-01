import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ProviderResult } from "../types";

/**
 * Fortnite Next Season Provider
 * 
 * Fetches season end date from Epic Games Help Center
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://www.epicgames.com/help/en-US/fortnite-c5719335176219/battle-royale-c5719350646299/when-does-the-current-fortnite-season-end-a5720184470299";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Fortnite help article: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for the season end date in the article body
    // Epic typically includes text like "Season ends on Month Day, Year"
    const bodyText = $("article, .article-body, main").text();

    // Try to find date patterns
    const datePatterns = [
        // "ends on March 8, 2026" or "ends March 8, 2026"
        /ends?\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
        // "until March 8, 2026"
        /until\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
        // "March 8, 2026"
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
        throw new Error("Could not extract season end date from Fortnite help article");
    }

    return {
        game: "fortnite",
        type: "next-season",
        title: "Fortnite Next Season",
        nextEventUtc: seasonEndDate.toISOString(),
        lastUpdatedUtc: new Date().toISOString(),
        source: {
            name: "Epic Games Help Center",
            url: url
        },
        confidence: "medium",
        notes: "Season end date may change"
    };
}
