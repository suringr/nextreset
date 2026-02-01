import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { ProviderResult } from "../types";

/**
 * Minecraft Last Release Provider
 * 
 * Fetches latest release from Minecraft Feedback changelog
 */
export async function run(): Promise<ProviderResult> {
    const url = "https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs";

    const response = await fetch(url, {
        headers: {
            "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
            "Accept-Language": "en-US"
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Minecraft changelog: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for article links in the changelog list
    // Typical structure: articles with dates or timestamps
    const articles = $("article, .article-list-item, a[href*='/articles/']").toArray();

    if (articles.length === 0) {
        throw new Error("No changelog articles found on Minecraft Feedback page");
    }

    // Try to extract date from the first article
    // Look for time tags or date indicators
    let releaseDate: Date | null = null;
    let releaseTitle = "";

    for (const article of articles.slice(0, 5)) {
        const $article = $(article);

        // Look for time element
        const timeEl = $article.find("time").first();
        if (timeEl.length > 0) {
            const datetime = timeEl.attr("datetime");
            if (datetime) {
                releaseDate = new Date(datetime);
                releaseTitle = $article.find("a, h2, h3").first().text().trim();
                break;
            }
        }

        // Alternative: look for text containing date patterns
        const text = $article.text();
        const dateMatch = text.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
        if (dateMatch) {
            releaseDate = new Date(dateMatch[1]);
            releaseTitle = $article.find("a, h2, h3").first().text().trim();
            break;
        }
    }

    if (!releaseDate || isNaN(releaseDate.getTime())) {
        throw new Error("Could not extract valid release date from Minecraft changelog");
    }

    return {
        game: "minecraft",
        type: "last-release",
        title: "Minecraft Last Release",
        nextEventUtc: releaseDate.toISOString(),
        lastUpdatedUtc: new Date().toISOString(),
        source: {
            name: "Minecraft Feedback - Release Changelogs",
            url: url
        },
        confidence: "high",
        notes: releaseTitle || undefined
    };
}
