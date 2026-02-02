/**
 * PUBG Last Patch Provider
 * 
 * Fetches latest patch date from official patch notes
 */

import * as cheerio from "cheerio";
import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
    game: "pubg",
    type: "last-patch",
    title: "PUBG Last Patch"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://pubg.com/en/news?category=patch_notes";

    try {
        const response = await fetchWithRetry(url);

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch PUBG patch notes: ${reason}`, lastGood);
        }

        const $ = cheerio.load(response.text);

        let lastPatchDate: Date | null = null;
        let patchTitle = "";

        $("article, .news-item, .card, a[href*='patch']").slice(0, 10).each((_, elem) => {
            const $elem = $(elem);

            const timeEl = $elem.find("time").first();
            if (timeEl.length > 0) {
                const datetime = timeEl.attr("datetime");
                if (datetime) {
                    const date = new Date(datetime);
                    if (!lastPatchDate || date > lastPatchDate) {
                        lastPatchDate = date;
                        patchTitle = $elem.find("h2, h3, .title").first().text().trim();
                    }
                }
            }

            const dateAttr = $elem.attr("data-date") || $elem.attr("data-published");
            if (dateAttr && !lastPatchDate) {
                const date = new Date(dateAttr);
                if (!isNaN(date.getTime())) {
                    lastPatchDate = date;
                    patchTitle = $elem.find("h2, h3").first().text().trim();
                }
            }

            if (!lastPatchDate) {
                const text = $elem.text();
                const dateMatch = text.match(/(\d{4}[-/.]\d{2}[-/.]\d{2})|([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/);
                if (dateMatch) {
                    const dateStr = dateMatch[1] || dateMatch[2];
                    const date = new Date(dateStr);
                    if (!isNaN(date.getTime())) {
                        lastPatchDate = date;
                        patchTitle = $elem.find("h2, h3").first().text().trim();
                    }
                }
            }
        });

        if (!lastPatchDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "Could not extract patch date from PUBG news page", lastGood);
        }

        const patchDate = lastPatchDate as Date;

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: patchDate.toISOString(),
            lastUpdatedUtc: new Date().toISOString(),
            source: {
                name: "PUBG - Patch Notes",
                url: url
            },
            confidence: "medium",
            status: "ok",
            notes: patchTitle || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
