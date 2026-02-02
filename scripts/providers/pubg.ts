/**
 * PUBG Last Patch Provider
 * 
 * Fetches latest patch date from official patch notes.
 * Robustness: Falls back to individual article page if listing date is missing.
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml, withBrowserPage, sleep, getBrowserBudgetRemaining } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "pubg",
    game: "pubg",
    type: "last-patch",
    title: "PUBG Last Patch"
};

export async function run(): Promise<ProviderResult> {
    const listingUrl = "https://pubg.com/en/news?category=patch_notes";

    try {
        const response = await fetchHtml(listingUrl, { useBrowserOnBlocked: true });

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

        let lastPatchDate: Date | null = null;
        let patchTitle = "";
        let articleUrl: string | null = null;
        const listingUrlBase = "https://pubg.com";

        // Try extracting URL and Date from listing
        const extractData = (html: string) => {
            const $_ = cheerio.load(html);
            let foundUrl: string | null = null;
            let foundDate: Date | null = null;

            $_("a").each((_, el) => {
                if (foundUrl) return;
                let href = $_(el).attr("href");
                if (href && /\/en\/news\/\d+/.test(href)) {
                    let absolute = href.startsWith("http") ? href : new URL(href, listingUrlBase).href;
                    foundUrl = absolute.split('?')[0];

                    // Try to find date in the same container or card
                    const card = $_(el).closest("article, .news-item, .card, div");
                    const dateText = card.text();
                    const dateMatch = dateText.match(/\d{4}\.\d{2}\.\d{2}/);
                    if (dateMatch) {
                        const parsed = new Date(dateMatch[0].replace(/\./g, '-'));
                        if (!isNaN(parsed.getTime())) foundDate = parsed;
                    }
                }
            });
            return { foundUrl, foundDate };
        };

        const result = extractData(response.text);
        articleUrl = result.foundUrl;
        if (result.foundDate) lastPatchDate = result.foundDate;

        // Fallback to browser if no article URL found on listing (likely SPA)
        if (!articleUrl && getBrowserBudgetRemaining() > 0) {
            console.log(`[PUBG] No article URL found via HTTP. Trying browser fallback...`);
            const browserResult = await withBrowserPage(async (page) => {
                await page.goto(listingUrl, { waitUntil: 'load', timeout: 30000 });
                await sleep(2000); // Wait for JS rendering
                return extractData(await page.content());
            });
            articleUrl = browserResult.foundUrl;
            if (browserResult.foundDate) lastPatchDate = browserResult.foundDate;
        }

        const finalListingUrl = response.url || listingUrl;

        // Hard Guards
        if (!articleUrl) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, FailureType.ParseFailed, "No article URL extracted from listing.", lastGood, response.status, response.mode);
        }

        const artUrlStr = articleUrl as string;

        if (artUrlStr === listingUrl || artUrlStr === finalListingUrl) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, FailureType.ParseFailed, `Article URL matches listing URL (${artUrlStr}).`, lastGood, response.status, response.mode);
        }

        if (artUrlStr.includes("category=patch_notes")) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, FailureType.ParseFailed, `Article URL contains patch_notes category (${artUrlStr}).`, lastGood, response.status, response.mode);
        }

        // Fetch the article page
        console.log(`[PUBG] Following link: ${artUrlStr} (listed on ${finalListingUrl})`);
        const articleResponse = await fetchHtml(artUrlStr, { useBrowserOnBlocked: true });

        if (!articleResponse.ok) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                articleResponse.failureType || FailureType.Unavailable,
                `Article fetch failed: ${articleUrl} (${articleResponse.status})`,
                lastGood,
                articleResponse.status,
                articleResponse.mode
            );
        }

        const $art = cheerio.load(articleResponse.text);
        $art("script, style, noscript").remove();

        // Update articleUrl to final URL (respecting redirects)
        articleUrl = articleResponse.url || articleUrl;

        // Date Extraction Logic: Header-first, then <time>
        let artDatetime: string | undefined;

        // 1. Search near title/header container
        const headerContainer = $art("header, .article-header, .news-detail__header").first();
        if (headerContainer.length > 0) {
            const timeEl = headerContainer.find("time, .date, .published-at").first();
            artDatetime = timeEl.attr("datetime") || timeEl.text().trim();
        }

        // 2. Fallback to common meta tags or any time element
        if (!artDatetime) {
            const fallbackTimeEl = $art("time, meta[property='article:published_time'], meta[name='publish-date'], .date").first();
            artDatetime = fallbackTimeEl.attr("datetime") || fallbackTimeEl.attr("content") || fallbackTimeEl.text().trim();
        }

        if (artDatetime) {
            // Clean up common PUBG date noise (e.g. "PATCH NOTES 2026.01.06")
            let cleanDate = artDatetime.replace(/PATCH NOTES/i, "").trim();

            // If year is missing (e.g. "January 7"), append current year
            if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}$/i.test(cleanDate)) {
                cleanDate += `, ${new Date().getFullYear()}`;
            }

            const parsedDate = new Date(cleanDate);

            // Date Validation Guardrail
            const now = new Date();
            const twoYearsAgo = new Date();
            twoYearsAgo.setFullYear(now.getFullYear() - 2);
            const twoYearsFuture = new Date();
            twoYearsFuture.setFullYear(now.getFullYear() + 2);

            if (!isNaN(parsedDate.getTime()) && parsedDate >= twoYearsAgo && parsedDate <= twoYearsFuture) {
                lastPatchDate = parsedDate;
                patchTitle = $art("h1, h2, .article-title, .title").first().text().trim();
            } else {
                console.log(`[PUBG] Invalid date candidate: ${artDatetime}`);
            }
        }

        // Final fallback: Regex search in text if all else fails
        if (!lastPatchDate) {
            const text = $art(".news-detail__content, .article-content, body").text();
            const dateMatch = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
            if (dateMatch) {
                const parsed = new Date(dateMatch[0]);
                if (!isNaN(parsed.getTime())) {
                    lastPatchDate = parsed;
                }
            }
        }

        // Final fallback: JSON-LD or regex search
        if (!lastPatchDate) {
            // Try JSON-LD
            const ldJson = $art("script[type='application/ld+json']").toArray();
            for (const script of ldJson) {
                try {
                    const data = JSON.parse($art(script).html() || "");
                    const date = data.datePublished || data.dateModified;
                    if (date) {
                        const parsed = new Date(date);
                        if (!isNaN(parsed.getTime())) {
                            lastPatchDate = parsed;
                            break;
                        }
                    }
                } catch (e) { }
            }

            if (!lastPatchDate) {
                const text = $art(".news-detail__content, .article-content, body").text();
                const dateMatch = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);
                if (dateMatch) {
                    const parsed = new Date(dateMatch[0]);
                    if (!isNaN(parsed.getTime())) {
                        lastPatchDate = parsed;
                    }
                }
            }
        }

        if (!lastPatchDate || isNaN(lastPatchDate.getTime())) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                `Could not extract valid patch date from PUBG article. Source: ${articleUrl}`,
                lastGood,
                articleResponse.status,
                articleResponse.mode
            );
        }

        return {
            ...META,
            status: "fresh",
            nextEventUtc: lastPatchDate.toISOString(),
            fetched_at_utc: new Date().toISOString(),
            source_url: articleUrl,
            confidence: Confidence.High,
            http_status: articleResponse.status,
            fetch_mode: articleResponse.mode,
            notes: patchTitle || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
