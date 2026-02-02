/**
 * Genshin Impact Next Banner Provider
 * 
 * Fetches banner end date from HoYoverse event notices
 */

import * as cheerio from "cheerio";
import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
    game: "genshin",
    type: "next-banner",
    title: "Genshin Impact Next Banner End"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://www.hoyolab.com/genshin/article/359862";

    try {
        const response = await fetchWithRetry(url);

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch Genshin Impact event notices: ${reason}`, lastGood);
        }

        const $ = cheerio.load(response.text);
        const bodyText = $("article, .content, main").text();

        const now = new Date();
        let bannerEndDate: Date | null = null;
        let bannerName = "";

        const patterns = [
            /until\s+(\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2})/i,
            /ends?\s+(?:on\s+)?(\d{4}[\/\-]\d{2}[\/\-]\d{2})/i
        ];

        for (const pattern of patterns) {
            const match = bodyText.match(pattern);
            if (match) {
                const dateStr = match[1].replace(/\//g, '-');
                const date = new Date(dateStr);

                if (!isNaN(date.getTime()) && date > now) {
                    bannerEndDate = date;

                    const wishMatch = bodyText.match(/([\w\s]+)\s+Wish/);
                    if (wishMatch) {
                        bannerName = wishMatch[1].trim();
                    }
                    break;
                }
            }
        }

        if (!bannerEndDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "Could not extract banner end date from Genshin Impact notices", lastGood);
        }

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: bannerEndDate.toISOString(),
            lastUpdatedUtc: now.toISOString(),
            source: {
                name: "HoYoLAB - Genshin Impact Notices",
                url: url
            },
            confidence: "medium",
            status: "ok",
            notes: bannerName || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
