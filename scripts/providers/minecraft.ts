/**
 * Minecraft Last Release Provider
 * 
 * Fetches latest release from Minecraft Feedback changelog
 */

import * as cheerio from "cheerio";
import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
    game: "minecraft",
    type: "last-release",
    title: "Minecraft Last Release"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs";

    try {
        const response = await fetchWithRetry(url);

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch Minecraft changelog: ${reason}`, lastGood);
        }

        const $ = cheerio.load(response.text);
        const articles = $("article, .article-list-item, a[href*='/articles/']").toArray();

        if (articles.length === 0) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "No changelog articles found on Minecraft Feedback page", lastGood);
        }

        let releaseDate: Date | null = null;
        let releaseTitle = "";

        for (const article of articles.slice(0, 5)) {
            const $article = $(article);

            const timeEl = $article.find("time").first();
            if (timeEl.length > 0) {
                const datetime = timeEl.attr("datetime");
                if (datetime) {
                    releaseDate = new Date(datetime);
                    releaseTitle = $article.find("a, h2, h3").first().text().trim();
                    break;
                }
            }

            const text = $article.text();
            const dateMatch = text.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
            if (dateMatch) {
                releaseDate = new Date(dateMatch[1]);
                releaseTitle = $article.find("a, h2, h3").first().text().trim();
                break;
            }
        }

        if (!releaseDate || isNaN(releaseDate.getTime())) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "Could not extract valid release date from Minecraft changelog", lastGood);
        }

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: releaseDate.toISOString(),
            lastUpdatedUtc: new Date().toISOString(),
            source: {
                name: "Minecraft Feedback - Release Changelogs",
                url: url
            },
            confidence: "high",
            status: "ok",
            notes: releaseTitle || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
