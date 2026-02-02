/**
 * Genshin Impact Next Banner Provider
 * 
 * Fetches banner end date from official news
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "genshin",
    game: "genshin",
    type: "next-banner",
    title: "Genshin Impact Next Banner End"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://genshin.hoyoverse.com/en/news";

    try {
        const response = await fetchHtml(url, { useBrowserOnBlocked: true });

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
        $("script, style, noscript").remove();

        const finalListingUrl = response.url || url;
        const now = new Date();
        let bannerEndDate: Date | null = null;
        let bannerName = "";
        let articleUrl: string | null = null;

        // Keywords for selecting the right news item
        const keywords = [/Event Wish/i, /Banner/i, /Available/i, /Time:/i, /Patch/i, /Update/i, /Version/i];

        // Look for items that look like wishes/banners
        $(".news__list .news__item, article, .news-item, .news-list li").each((_, elem) => {
            if (articleUrl) return; // Only process the first match

            const $item = $(elem);
            const text = $item.text().trim();

            const hasKeyword = keywords.some(kw => kw.test(text));
            if (hasKeyword) {
                articleUrl = $item.find("a").attr("href") || $item.attr("href") || null;
                if (articleUrl && !articleUrl.startsWith("http")) {
                    articleUrl = new URL(articleUrl, url).href;
                }
                bannerName = $item.find("h3, .title").text().trim();
            }
        });

        if (articleUrl) {
            console.log(`[Genshin] Following link: ${articleUrl} (from ${finalListingUrl})`);
            const articleResponse = await fetchHtml(articleUrl, { useBrowserOnBlocked: true });

            if (articleResponse.ok) {
                const $art = cheerio.load(articleResponse.text);
                $art("script, style, noscript").remove();
                const artText = $art("article, .article-body, main, #main-content").text() || $art("body").text();

                // Look for explicit end time in the article body
                // Often looks like "Event End Time: 2024/01/30 14:59:59"
                const endPatterns = [
                    /End\s+Time[:\s]+(\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}:\d{2})/i,
                    /End\s+Time[:\s]+(\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2})/i,
                    /until\s+(\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}:\d{2})/i,
                    /(\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}:\d{2})/
                ];

                for (const pattern of endPatterns) {
                    const match = artText.match(pattern);
                    if (match) {
                        const dateStr = match[1].replace(/\//g, '-');
                        const date = new Date(dateStr);

                        if (!isNaN(date.getTime())) {
                            // Date Validation Guardrail
                            const twoYearsAgo = new Date();
                            twoYearsAgo.setFullYear(now.getFullYear() - 2);
                            const twoYearsFuture = new Date();
                            twoYearsFuture.setFullYear(now.getFullYear() + 2);

                            if (date > now && date <= twoYearsFuture) {
                                bannerEndDate = date;
                                break;
                            }
                        }
                    }
                }
                // Update articleUrl to final URL
                articleUrl = articleResponse.url || articleUrl;
            }
        }

        if (!bannerEndDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                `Could not extract explicit banner end date from Genshin news. Source: ${articleUrl || finalListingUrl}`,
                lastGood,
                response.status,
                response.mode
            );
        }

        return {
            ...META,
            status: "fresh",
            nextEventUtc: bannerEndDate.toISOString(),
            fetched_at_utc: now.toISOString(),
            source_url: articleUrl || finalListingUrl,
            confidence: Confidence.Medium,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: bannerName || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
