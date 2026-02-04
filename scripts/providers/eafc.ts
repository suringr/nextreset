/**
 * EA SPORTS FC Last Title Update Provider
 * 
 * Scrapes EA Forums Game Info Hub for Title Updates.
 * Source: https://forums.ea.com/category/ea-sports-fc-en/blog/ea-sports-fc-game-info-hub-en
 * Semantics: Last Title Update = latest blog entry with "Title Update" in title.
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "ea-sports-fc",
    game: "ea-sports-fc",
    type: "last-title-update",
    title: "EA SPORTS FC Last Title Update"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://forums.ea.com/category/ea-sports-fc-en/blog/ea-sports-fc-game-info-hub-en";

    try {
        const response = await fetchHtml(url, {
            providerId: META.provider_id
        });

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

        let latestDate: Date | null = null;
        let latestTitle = "";
        let latestUrl = url;

        $('a').each((_, elem) => {
            if (latestDate) return;

            const $el = $(elem);
            const title = $el.text().trim();
            const href = $el.attr('href') || "";

            // Check if title looks like an update
            const upperTitle = title.toUpperCase();
            if (!upperTitle.includes("TITLE UPDATE") && !upperTitle.includes("PATCH NOTES") && !upperTitle.includes("UPDATE NOTES") && !upperTitle.includes("VERSION")) {
                return;
            }

            // Extract date logic
            let date: Date | null = null;

            // 1. Try to find a date in surrounding text (parent's text)
            let context = $el.parent().text();
            if (context.length < 200) context += " " + $el.parent().parent().text();

            // Standard date match
            const dateMatch = context.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
            if (dateMatch) {
                date = new Date(dateMatch[1]);
            } else {
                // Try to look for <time> tags 
                const card = $el.closest('li, div[class*="entry"], div[class*="row"]');
                const timeText = card.find('time').text() || card.find('[class*="date"]').text();
                if (timeText) {
                    const d = new Date(timeText);
                    if (!isNaN(d.getTime())) date = d;
                }
            }

            // 2. Relative Date Fallback
            if (!date) {
                const relativeMatch = context.match(/(\d+)\s+(hour|day|week|month)s?\s+ago/i);
                if (relativeMatch) {
                    const amount = parseInt(relativeMatch[1], 10);
                    const unit = relativeMatch[2].toLowerCase();
                    const now = new Date();

                    if (unit.startsWith('hour')) {
                        now.setHours(now.getHours() - amount);
                        date = now;
                    } else if (unit.startsWith('day')) {
                        now.setDate(now.getDate() - amount);
                        date = now;
                    } else if (unit.startsWith('week')) {
                        now.setDate(now.getDate() - (amount * 7));
                        date = now;
                    } else if (unit.startsWith('month')) {
                        now.setMonth(now.getMonth() - amount);
                        date = now;
                    }
                }
            }

            if (date && !isNaN(date.getTime())) {
                latestDate = date;
                latestTitle = title;
                latestUrl = href.startsWith('http') ? href : `https://forums.ea.com${href}`;
            }
        });

        if (!latestDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "Could not find any 'Title Update' articles with dates on EA Forums",
                lastGood,
                response.status,
                response.mode
            );
        }

        return {
            ...META,
            status: "fresh",
            // Cast to ensure TS is happy
            nextEventUtc: (latestDate as unknown as Date).toISOString(),
            fetched_at_utc: new Date().toISOString(),
            source_url: latestUrl,
            confidence: Confidence.Medium,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: latestTitle
        };

    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
