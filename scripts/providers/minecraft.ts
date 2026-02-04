/**
 * Minecraft Last Release Provider
 * 
 * Fetches latest release from Minecraft Feedback changelog
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml, withBrowserPage, sleep } from "../lib/fetch-layer";

const META: ProviderMetadata = {
    provider_id: "minecraft",
    game: "minecraft",
    type: "last-release",
    title: "Minecraft Last Release"
};

export async function run(): Promise<ProviderResult> {
    const listingUrl = "https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs";

    try {
        // Try HTTP first
        const response = await fetchHtml(listingUrl, { providerId: META.provider_id, useBrowserOnBlocked: false });

        if (!response.ok && (response.status === 403 || response.status === 429)) {
            console.log(`[Minecraft] Listing blocked (${response.status}). Using single browser session...`);
            return await runWithBrowserSession(listingUrl);
        }

        if (!response.ok) {
            throw new Error(response.error || `HTTP ${response.status}`);
        }

        // Proceed with standard HTTP flow
        return await parseWithHtml(response.text, response.url || listingUrl, response.status, response.mode);

    } catch (error) {
        throw error;
    }
}

/**
 * Handle listing and article fetch in a single browser session
 */
async function runWithBrowserSession(listingUrl: string): Promise<ProviderResult> {
    try {
        return await withBrowserPage(async (page) => {
            // 1. Visit listing
            await page.goto(listingUrl, { waitUntil: 'load', timeout: 30000 });
            await page.waitForSelector('.article-list, .article-list-item, article, a[href*="/articles/"]', { timeout: 10000 }).catch(() => { });
            await sleep(2000);
            const listingHtml = await page.content();
            const finalListingUrl = page.url();

            const articleUrl = extractArticleUrl(listingHtml, listingUrl);

            if (!articleUrl || articleUrl === listingUrl || articleUrl === finalListingUrl) {
                throw new Error("Could not extract valid article URL in browser session.");
            }

            // 2. Visit article
            console.log(`[Minecraft] Following link in same session: ${articleUrl}`);
            await page.goto(articleUrl, { waitUntil: 'load', timeout: 30000 });
            await sleep(1000); // Wait for potential dynamic load
            const finalArticleUrl = page.url();

            // Extract via Page Locator for robustness
            const getDate = async (sel: string) => {
                const loc = page.locator(sel).first();
                if (await loc.count() > 0) {
                    return (await loc.getAttribute('datetime')) || (await loc.getAttribute('title')) || (await loc.innerText());
                }
                return null;
            };

            let extractedDate = (await getDate('time')) || (await getDate('.article-meta time')) || (await getDate('.date')) || (await getDate('.article-date'));

            if (!extractedDate) {
                const bodyText = await page.innerText('body');
                const broadRegex = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i;
                const match = bodyText.match(broadRegex);
                if (match) extractedDate = match[0];
            }

            const extractedTitle = await page.locator('h1, h2, .article-title, .title').first().innerText().catch(() => "");
            const finalHtml = await page.content();

            // If found a date, use it
            if (extractedDate) {
                const parsed = new Date(extractedDate);
                if (!isNaN(parsed.getTime())) {
                    return {
                        ...META,
                        status: "fresh",
                        nextEventUtc: parsed.toISOString(),
                        fetched_at_utc: new Date().toISOString(),
                        last_success_at_utc: new Date().toISOString(),
                        source_url: finalArticleUrl,
                        confidence: Confidence.High,
                        http_status: 200,
                        fetch_mode: "browser",
                        notes: extractedTitle || undefined
                    };
                }
            }

            return await parseWithHtml(finalHtml, finalArticleUrl, 200, "browser");
        });
    } catch (err: any) {
        throw err;
    }
}

/**
 * Common parsing logic for both HTTP and Browser flows
 */
async function parseWithHtml(html: string, sourceUrl: string, status: number, mode: "http" | "browser"): Promise<ProviderResult> {
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();

    // If sourceUrl is the listing, we need to extract and fetch article (only for HTTP flow)
    if (sourceUrl.includes("sections/360001186971")) {
        const articleUrl = extractArticleUrl(html, sourceUrl);
        if (articleUrl && articleUrl !== sourceUrl) {
            console.log(`[Minecraft] Following link (HTTP): ${articleUrl}`);
            const articleResponse = await fetchHtml(articleUrl, { providerId: META.provider_id, useBrowserOnBlocked: true });
            if (articleResponse.ok) {
                return await parseWithHtml(articleResponse.text, articleResponse.url || articleUrl, articleResponse.status, articleResponse.mode);
            }
        }
    }

    // Extract Date
    let releaseDate: Date | null = null;
    let releaseTitle = "";

    const artTimeEl = $("time, .date, .published-at, meta[property='article:published_time'], .article-meta time, .article-date").first();
    const artDatetime = artTimeEl.attr("datetime") || artTimeEl.attr("content") || artTimeEl.text().trim() || artTimeEl.attr("title");

    if (artDatetime) {
        const parsedDate = new Date(artDatetime);
        const now = new Date();
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(now.getFullYear() - 2);
        const twoYearsFuture = new Date();
        twoYearsFuture.setFullYear(now.getFullYear() + 2);

        if (!isNaN(parsedDate.getTime()) && parsedDate >= twoYearsAgo && parsedDate <= twoYearsFuture) {
            releaseDate = parsedDate;
            releaseTitle = $("h1, h2, .article-title, .title").first().text().trim();
        }
    }

    // Final fallback: JSON-LD or regex
    if (!releaseDate) {
        // Try JSON-LD
        const ldJson = $("script[type='application/ld+json']").toArray();
        for (const script of ldJson) {
            try {
                const data = JSON.parse($(script).html() || "");
                const date = data.datePublished || data.dateModified || data.uploadDate;
                if (date) {
                    const parsed = new Date(date);
                    if (!isNaN(parsed.getTime())) {
                        releaseDate = parsed;
                        break;
                    }
                }
            } catch (e) { }
        }

        if (!releaseDate) {
            const bodyText = $("body").text();
            // Broader regex: supports Jan/January and optional comma
            const broadRegex = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i;
            const dateMatch = bodyText.match(broadRegex);
            if (dateMatch) {
                const parsed = new Date(dateMatch[0]);
                if (!isNaN(parsed.getTime())) {
                    releaseDate = parsed;
                }
            }
        }
    }

    if (!releaseDate) {
        throw new Error(`Could not extract valid release date from Minecraft article. Source: ${sourceUrl}`);
    }

    return {
        ...META,
        status: "fresh",
        nextEventUtc: releaseDate.toISOString(),
        fetched_at_utc: new Date().toISOString(),
        last_success_at_utc: new Date().toISOString(),
        source_url: sourceUrl,
        confidence: Confidence.High,
        http_status: status,
        fetch_mode: mode,
        notes: releaseTitle || undefined
    };
}

function extractArticleUrl(html: string, baseUrl: string): string | null {
    const $ = cheerio.load(html);
    // Broaden selectors for Zendesk articles
    const articles = $(".article-list-item, .article-list-link, .article-list a, article, .blocks-item, a[href*='/articles/']").toArray();

    for (const art of articles) {
        const $artLink = $(art).find("a").length > 0 ? $(art).find("a") : $(art);
        let href = $artLink.attr("href");
        let title = $artLink.text().toLowerCase().trim();

        if (href) {
            let absolute = new URL(href, baseUrl).href;
            if (!href.startsWith("#")) {
                const titleLower = title.toLowerCase();
                const hasVersion = /\d+\.\d+/.test(titleLower);
                if (titleLower.includes("changelog") || titleLower.includes("patch") || titleLower.includes("release") || hasVersion) {
                    return absolute;
                }
            }
        }
    }
    return null;
}

