import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ProviderResult } from "../types";

/**
 * Call of Duty Warzone Last Patch Provider
 * 
 * Fetches latest patch date from CoD patch notes
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://www.callofduty.com/patchnotes";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Warzone patch notes: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const result: { date: Date; title: string } | null = (() => {
        let latest: { date: Date; title: string } | null = null;

        // Find articles or cards mentioning Warzone
        $("article, .patch-note, .card, a").each((_, elem) => {
            const $elem = $(elem);
            const text = $elem.text();

            // Check if this is a Warzone patch
            if (!text.toLowerCase().includes("warzone")) {
                return;
            }

            // Look for time element
            const timeEl = $elem.find("time").first();
            if (timeEl.length > 0) {
                const datetime = timeEl.attr("datetime");
                if (datetime) {
                    const date = new Date(datetime);
                    if (!latest || date > latest.date) {
                        latest = {
                            date,
                            title: $elem.find("h2, h3, .title").first().text().trim()
                        };
                    }
                }
            }

            // Alternative: extract date from text
            if (!latest) {
                const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})|([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/);
                if (dateMatch) {
                    const dateStr = dateMatch[1] || dateMatch[2];
                    const date = new Date(dateStr);
                    if (!isNaN(date.getTime())) {
                        latest = {
                            date,
                            title: $elem.find("h2, h3").first().text().trim()
                        };
                    }
                }
            }
        });

        return latest;
    })();

    if (!result) {
        throw new Error("Could not extract Warzone patch date from CoD patch notes");
    }

    // Type assertion to help TypeScript narrow the type after null check
    const patchData = result as { date: Date; title: string };

    return {
        game: "warzone",
        type: "last-patch",
        title: "Call of Duty Warzone Last Patch",
        nextEventUtc: patchData.date.toISOString(),
        lastUpdatedUtc: new Date().toISOString(),
        source: {
            name: "Call of Duty - Patch Notes",
            url: url
        },
        confidence: "medium",
        notes: patchData.title || undefined
    };
}
