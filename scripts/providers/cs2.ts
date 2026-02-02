/**
 * Counter-Strike 2 Last Update Provider
 * 
 * Fetches latest news from Steam Store RSS feed
 */

import { XMLParser } from "fast-xml-parser";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "cs2",
    game: "cs2",
    type: "last-update",
    title: "Counter-Strike 2 Last Update"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://store.steampowered.com/feeds/news/app/730/?l=english";

    try {
        const response = await fetchHtml(url);

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

        // Parse RSS/XML
        const parser = new XMLParser();
        const feed = parser.parse(response.text);

        // Navigate to items (RSS structure: rss.channel.item)
        const items = feed.rss?.channel?.item;

        if (!items || !Array.isArray(items) || items.length === 0) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "No items found in CS2 RSS feed",
                lastGood,
                response.status,
                response.mode
            );
        }

        // Get the first (most recent) item's pubDate
        const latestItem = items[0];
        const pubDate = latestItem.pubDate;

        if (!pubDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "No pubDate found in latest CS2 news item",
                lastGood,
                response.status,
                response.mode
            );
        }

        // Parse date and convert to ISO 8601 UTC
        const lastUpdateDate = new Date(pubDate);

        if (isNaN(lastUpdateDate.getTime())) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                `Invalid date format in CS2 RSS: ${pubDate}`,
                lastGood,
                response.status,
                response.mode
            );
        }

        return {
            ...META,
            status: "fresh",
            nextEventUtc: lastUpdateDate.toISOString(),
            fetched_at_utc: new Date().toISOString(),
            source_url: "https://store.steampowered.com/news/app/730",
            confidence: Confidence.High,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: latestItem.title ? `Latest: ${latestItem.title}` : undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
