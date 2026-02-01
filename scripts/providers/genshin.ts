import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ProviderResult } from "../types";

/**
 * Genshin Impact Next Banner Provider
 * 
 * Fetches banner end date from HoYoverse event notices
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://www.hoyolab.com/genshin/article/359862";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Genshin Impact event notices: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for banner end times in the content
    // Genshin typically shows "until YYYY/MM/DD HH:MM" in event notices
    const bodyText = $("article, .content, main").text();

    const now = new Date();
    let bannerEndDate: Date | null = null;
    let bannerName = "";

    // Try to find "until" or "ends" with datetime
    const patterns = [
        // "until 2026/03/08 17:59" format
        /until\s+(\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2})/i,
        // "ends on YYYY/MM/DD"
        /ends?\s+(?:on\s+)?(\d{4}[\/\-]\d{2}[\/\-]\d{2})/i
    ];

    for (const pattern of patterns) {
        const match = bodyText.match(pattern);
        if (match) {
            const dateStr = match[1].replace(/\//g, '-');
            const date = new Date(dateStr);

            if (!isNaN(date.getTime()) && date > now) {
                bannerEndDate = date;

                // Try to extract banner name (look for "Wish" mentions)
                const wishMatch = bodyText.match(/([\w\s]+)\s+Wish/);
                if (wishMatch) {
                    bannerName = wishMatch[1].trim();
                }
                break;
            }
        }
    }

    if (!bannerEndDate) {
        throw new Error("Could not extract banner end date from Genshin Impact notices");
    }

    return {
        game: "genshin",
        type: "next-banner",
        title: "Genshin Impact Next Banner End",
        nextEventUtc: bannerEndDate.toISOString(),
        lastUpdatedUtc: now.toISOString(),
        source: {
            name: "HoYoLAB - Genshin Impact Notices",
            url: url
        },
        confidence: "medium",
        notes: bannerName || undefined
    };
}
