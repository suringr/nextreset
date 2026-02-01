import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import { ProviderResult } from "../types";

/**
 * Counter-Strike 2 Last Update Provider
 * 
 * Fetches latest news from Steam Store RSS feed
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://store.steampowered.com/feeds/news/app/730/?l=english";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch CS2 RSS: ${response.status} ${response.statusText}`);
    }

    const xmlText = await response.text();

    // Parse RSS/XML
    const parser = new XMLParser();
    const feed = parser.parse(xmlText);

    // Navigate to items (RSS structure: rss.channel.item)
    const items = feed.rss?.channel?.item;

    if (!items || !Array.isArray(items) || items.length === 0) {
        throw new Error("No items found in CS2 RSS feed");
    }

    // Get the first (most recent) item's pubDate
    const latestItem = items[0];
    const pubDate = latestItem.pubDate;

    if (!pubDate) {
        throw new Error("No pubDate found in latest CS2 news item");
    }

    // Parse date and convert to ISO 8601 UTC
    const lastUpdateDate = new Date(pubDate);

    if (isNaN(lastUpdateDate.getTime())) {
        throw new Error(`Invalid date format in CS2 RSS: ${pubDate}`);
    }

    return {
        game: "cs2",
        type: "last-update",
        title: "Counter-Strike 2 Last Update",
        nextEventUtc: lastUpdateDate.toISOString(),
        lastUpdatedUtc: new Date().toISOString(),
        source: {
            name: "Steam Store - CS2 News",
            url: "https://store.steampowered.com/news/app/730"
        },
        confidence: "high",
        notes: latestItem.title ? `Latest: ${latestItem.title}` : undefined
    };
}
