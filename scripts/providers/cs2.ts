/**
 * Counter-Strike 2 Last Update Provider
 * 
 * Fetches latest news from Steam Store RSS feed
 */

import { XMLParser } from "fast-xml-parser";
import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
    game: "cs2",
    type: "last-update",
    title: "Counter-Strike 2 Last Update"
};

/**
 * Safe run function - never throws
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://store.steampowered.com/feeds/news/app/730/?l=english";

    try {
        const response = await fetchWithRetry(url);

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch CS2 RSS: ${reason}`, lastGood);
        }

        // Parse RSS/XML
        const parser = new XMLParser();
        const feed = parser.parse(response.text);

        // Navigate to items (RSS structure: rss.channel.item)
        const items = feed.rss?.channel?.item;

        if (!items || !Array.isArray(items) || items.length === 0) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "No items found in CS2 RSS feed", lastGood);
        }

        // Get the first (most recent) item's pubDate
        const latestItem = items[0];
        const pubDate = latestItem.pubDate;

        if (!pubDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "No pubDate found in latest CS2 news item", lastGood);
        }

        // Parse date and convert to ISO 8601 UTC
        const lastUpdateDate = new Date(pubDate);

        if (isNaN(lastUpdateDate.getTime())) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Invalid date format in CS2 RSS: ${pubDate}`, lastGood);
        }

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: lastUpdateDate.toISOString(),
            lastUpdatedUtc: new Date().toISOString(),
            source: {
                name: "Steam Store - CS2 News",
                url: "https://store.steampowered.com/news/app/730"
            },
            confidence: "high",
            status: "ok",
            notes: latestItem.title ? `Latest: ${latestItem.title}` : undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
