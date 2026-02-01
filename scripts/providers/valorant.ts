import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ProviderResult } from "../types";

/**
 * VALORANT Last Patch Provider
 * 
 * Fetches latest patch date from official patch notes
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://playvalorant.com/en-us/news/game-updates/";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch VALORANT patch notes: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for the most recent patch note article
    let lastPatchDate: Date | null = null;
    let patchTitle = "";

    // Find article cards or links
    $("article, .article-card, a[href*='patch-notes']").slice(0, 10).each((_, elem) => {
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

        // Alternative: look for date in text
        const text = $elem.text();
        const dateMatch = text.match(/(\d{4}[-/]\d{2}[-/]\d{2})|([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/);
        if (dateMatch && !lastPatchDate) {
            const dateStr = dateMatch[1] || dateMatch[2];
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                lastPatchDate = date;
                patchTitle = $elem.find("h2, h3, .title").first().text().trim();
            }
        }
    });

    if (!lastPatchDate) {
        throw new Error("Could not extract patch date from VALOR ANT news page");
    }

    const patchDate = lastPatchDate as Date;

    return {
        game: "valorant",
        type: "last-patch",
        title: "VALORANT Last Patch",
        nextEventUtc: patchDate.toISOString(),
        lastUpdatedUtc: new Date().toISOString(),
        source: {
            name: "VALORANT - Patch Notes",
            url: url
        },
        confidence: "medium",
        notes: patchTitle || undefined
    };
}
