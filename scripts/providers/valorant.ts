/**
 * VALORANT Last Patch Provider
 * 
 * Fetches latest patch date from official patch notes
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "valorant",
    game: "valorant",
    type: "last-patch",
    title: "VALORANT Last Patch"
};

export async function run(): Promise<ProviderResult> {
    const url = "https://playvalorant.com/en-us/news/game-updates/";

    try {
        const response = await fetchHtml(url);

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

        let lastPatchDate: Date | null = null;
        let patchTitle = "";

        $("article, .article-card, a[href*='patch-notes']").slice(0, 10).each((_, elem) => {
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

            if (!lastPatchDate) {
                const text = $elem.text();
                const dateMatch = text.match(/(\d{4}[-/]\d{2}[-/]\d{2})|([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/);
                if (dateMatch) {
                    const dateStr = dateMatch[1] || dateMatch[2];
                    const date = new Date(dateStr);
                    if (!isNaN(date.getTime())) {
                        lastPatchDate = date;
                        patchTitle = $elem.find("h2, h3, .title").first().text().trim();
                    }
                }
            }
        });

        if (!lastPatchDate) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "Could not extract patch date from VALORANT news page",
                lastGood,
                response.status,
                response.mode
            );
        }

        const finalDate = lastPatchDate as Date;

        return {
            ...META,
            status: "fresh",
            nextEventUtc: finalDate.toISOString(),
            fetched_at_utc: new Date().toISOString(),
            source_url: url,
            confidence: Confidence.Medium,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: patchTitle || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
