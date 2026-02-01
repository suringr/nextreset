import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ProviderResult } from "../types";

/**
 * PUBG Last Patch Provider
 * 
 * Fetches latest patch date from official patch notes
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://pubg.com/en/news?category=patch_notes";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch PUBG patch notes: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for the most recent patch article
    let lastPatchDate: Date | null = null;
    let patchTitle = "";

    // Find article cards or news items
    $("article, .news-item, .card, a[href*='patch']").slice(0, 10).each((_, elem) => {
        const $elem = $(elem);

        // Look for time element
        const timeEl = $elem.find("time").first();
        if (timeEl.length > 0) {
            const datetime = timeEl.attr("datetime");
            if (datetime) {
                const date = new Date(datetime);
                if (!lastPatchDate || date > lastPatchDate) {
                    lastPatchDate = date;
                    patchTitle = $elem.find("h2, h3, .title").first().text().trim();
                }
            }
        }

        // Alternative: look for date in text or data attributes
        const dateAttr = $elem.attr("data-date") || $elem.attr("data-published");
        if (dateAttr && !lastPatchDate) {
            const date = new Date(dateAttr);
            if (!isNaN(date.getTime())) {
                lastPatchDate = date;
                patchTitle = $elem.find("h2, h3").first().text().trim();
            }
        }

        // Text-based extraction
        if (!lastPatchDate) {
            const text = $elem.text();
            const dateMatch = text.match(/(\d{4}[-/.]\d{2}[-/.]\d{2})|([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/);
            if (dateMatch) {
                const dateStr = dateMatch[1] || dateMatch[2];
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                    lastPatchDate = date;
                    patchTitle = $elem.find("h2, h3").first().text().trim();
                }
            }
        }
    });

    if (!lastPatchDate) {
        throw new Error("Could not extract patch date from PUBG news page");
    }

    // Type assertion to help TypeScript narrow the type after null check
    const patchDate = lastPatchDate as Date;

    return {
        game: "pubg",
        type: "last-patch",
        title: "PUBG Last Patch",
        nextEventUtc: patchDate.toISOString(),
        lastUpdatedUtc: new Date().toISOString(),
        source: {
            name: "PUBG - Patch Notes",
            url: url
        },
        confidence: "medium",
        notes: patchTitle || undefined
    };
}
