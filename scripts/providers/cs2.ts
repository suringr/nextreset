/**
 * Counter-Strike 2 Last Patch Provider
 * 
 * Primary: Official CS2 Updates Page (Browser)
 * Fallback: Steam RSS Feed (HTTP)
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml, withBrowserPage, getBrowserBudgetRemaining, sleep } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";
import { XMLParser } from "fast-xml-parser";

const META: ProviderMetadata = {
    provider_id: "cs2",
    game: "cs2",
    type: "last-update",
    title: "Counter-Strike 2 Last Update"
};

export async function run(): Promise<ProviderResult> {
    // Try Official Site (Browser) first
    if (getBrowserBudgetRemaining() > 0) {
        try {
            return await withBrowserPage(async (page) => {
                const url = "https://www.counter-strike.net/news/updates";
                console.log("[CS2] Navigating to official site...");

                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // Don't strict wait for selectors, updates page lists are sometimes static or simple
                // Just wait a moment for any hydration
                await sleep(3000);

                const content = await page.content();
                const $ = cheerio.load(content);

                let latestDate: Date | null = null;
                let latestTitle = "";
                let latestUrl = url;

                // Structure on counter-strike.net is often:
                // <div class="blog_post"> ... <div class="date">...</div> ... </div>
                // OR just look for the first text that looks like a date.
                // The page is usually chronological.

                // Strategy: Find all dates, take the most recent (which should be the first)

                // Try specific selectors first just in case
                const candidates = $('.blog_post, .release_notes_post, a[href*="/news/entry/"]');

                candidates.each((_, elem) => {
                    if (latestDate) return;

                    const $el = $(elem);
                    const dateText = $el.find('.date').text() || $el.find('time').text();
                    const titleText = $el.find('.title').text() || $el.text().slice(0, 50);

                    if (dateText) {
                        const d = new Date(dateText);
                        if (!isNaN(d.getTime())) {
                            latestDate = d;
                            latestTitle = titleText.trim();
                            const href = $el.find('a').attr('href');
                            if (href) latestUrl = href;
                        }
                    }
                });

                // Fallback: Scan text for dates if selectors failed
                if (!latestDate) {
                    const text = $('body').text();
                    // Match "Release Notes for 11/13/2023" or "2023.11.13" or "November 13, 2023"
                    const match = text.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
                    if (match) {
                        latestDate = new Date(match[1]);
                        latestTitle = "Counter-Strike 2 Update";
                    }
                }

                if (!latestDate) {
                    throw new Error("Could not find any dated articles on CS2 official page");
                }

                const finalDate = latestDate as unknown as Date;

                return {
                    ...META,
                    status: "fresh",
                    nextEventUtc: finalDate.toISOString(),
                    fetched_at_utc: new Date().toISOString(),
                    source_url: latestUrl,
                    confidence: Confidence.High,
                    fetch_mode: "browser",
                    notes: latestTitle
                };
            });
        } catch (error) {
            console.warn(`[CS2] Official site fetch failed... Falling back to RSS.`);
            // Fall through to RSS
        }
    } else {
        console.log(`[CS2] Browser budget low, skipping official site. Using RSS fallback.`);
    }

    // Fallback: Steam RSS
    const rssUrl = "https://store.steampowered.com/feeds/news/app/730/?l=english";
    try {
        const response = await fetchHtml(rssUrl);
        if (!response.ok) {
            throw new Error(`RSS HTTP ${response.status}`);
        }

        const parser = new XMLParser({ ignoreAttributes: false });
        const xml = parser.parse(response.text);

        // RSS structure: rss -> channel -> item[]
        const items = xml?.rss?.channel?.item;
        if (!Array.isArray(items) || items.length === 0) {
            throw new Error("Invalid RSS feed format");
        }

        // Find first item that is an Update (ignore generic community announcements if possible)
        // Steam news includes "events", etc.
        // We look for "Update" or "Patch" in title

        let latestEntry = items.find((item: any) =>
            /Update/i.test(item.title) || /Patch/i.test(item.title) || /Release Notes/i.test(item.title)
        );

        // If no strict update found, take the very first item as it's likely news
        if (!latestEntry) {
            latestEntry = items[0];
        }

        const pubDate = new Date(latestEntry.pubDate);
        if (isNaN(pubDate.getTime())) {
            throw new Error("Invalid date in RSS item");
        }

        return {
            ...META,
            status: "fresh",
            nextEventUtc: pubDate.toISOString(),
            fetched_at_utc: new Date().toISOString(),
            source_url: latestEntry.link || rssUrl,
            confidence: Confidence.High,
            notes: latestEntry.title,
            fetch_mode: "http"
        };

    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
