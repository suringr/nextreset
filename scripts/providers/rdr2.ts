/**
 * Red Dead Redemption 2 Last Official Update Provider
 * 
 * Scrapes Rockstar Games Newswire for the latest "Red Dead" news.
 * Source: https://www.rockstargames.com/newswire
 * Semantics: Last Official Update = latest Newswire item containing "Red Dead"
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml, withBrowserPage, sleep, getBrowserBudgetRemaining } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "red-dead-redemption-2",
    game: "red-dead-redemption-2",
    type: "last-update",
    title: "Red Dead Redemption 2 Last Update"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://www.rockstargames.com/newswire";

    // Helper to parse content (shared between HTTP and Browser)
    const parse = ($: cheerio.CheerioAPI, sourceUrl: string) => {
        let latestDate: Date | null = null;
        let latestTitle = "";
        let latestUrl = sourceUrl;

        let foundCount = 0;

        // Rockstar Newswire structure: <a> tags wrapping articles
        $('a[href*="/newswire/article/"]').each((_, elem) => {
            if (latestDate) return;

            const $el = $(elem);
            const linkUrl = $el.attr('href') || "";
            const textContent = $el.text();
            const title = $el.find('h3, h4, [class*="title"]').text().trim() || textContent.trim().split('\n')[0];

            // Check relevance
            if (!/Red Dead/i.test(textContent) && !/RDR2/i.test(textContent) && !/Red Dead/i.test(title)) {
                return;
            }

            foundCount++;

            // Extract date
            const dateText = $el.find('time').text() || $el.find('[class*="date"]').text();
            let date: Date | null = null;
            if (dateText) {
                const parsed = new Date(dateText);
                if (!isNaN(parsed.getTime())) date = parsed;
            }

            if (!date) {
                const match = textContent.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
                if (match) {
                    date = new Date(match[1]);
                }
            }

            if (date && !isNaN(date.getTime())) {
                latestDate = date;
                latestTitle = title;
                latestUrl = linkUrl.startsWith('http') ? linkUrl : `https://www.rockstargames.com${linkUrl}`;
            }
        });

        return { latestDate, latestTitle, latestUrl, foundCount };
    };

    try {
        // 1. Try HTTP First
        const response = await fetchHtml(url, {
            providerId: META.provider_id,
            headers: { "Accept": "text/html" }
        });

        if (response.ok) {
            const $ = cheerio.load(response.text);
            const { latestDate, latestTitle, latestUrl, foundCount } = parse($, url);

            if (foundCount > 0 && latestDate) {
                return {
                    ...META,
                    status: "fresh",
                    nextEventUtc: (latestDate as unknown as Date).toISOString(),
                    fetched_at_utc: new Date().toISOString(),
                    source_url: latestUrl,
                    confidence: Confidence.Medium,
                    http_status: response.status,
                    fetch_mode: "http",
                    notes: latestTitle
                };
            }
            console.log(`[RDR2] HTTP fetch found ${foundCount} relevant articles. Switching to browser...`);
        }

        // 2. Fallback to Browser
        if (getBrowserBudgetRemaining() > 0) {
            return await withBrowserPage(async (page) => {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await sleep(3000); // Hydration

                const content = await page.content();
                const $ = cheerio.load(content);
                const { latestDate, latestTitle, latestUrl } = parse($, url);

                if (!latestDate) {
                    throw new Error("Could not find any 'Red Dead' articles with dates on Newswire (Browser)");
                }

                return {
                    ...META,
                    status: "fresh",
                    nextEventUtc: (latestDate as unknown as Date).toISOString(),
                    fetched_at_utc: new Date().toISOString(),
                    source_url: latestUrl,
                    confidence: Confidence.High,
                    fetch_mode: "browser",
                    notes: latestTitle
                };
            });
        }

        throw new Error("HTTP failed to find content and Browser budget exhausted");

    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);

        if (reason.includes("budget exhausted")) {
            return buildFallback(META, FailureType.Blocked, "Browser budget exhausted", lastGood);
        }

        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
