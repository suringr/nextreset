/**
 * Call of Duty Warzone Last Patch Provider
 * 
 * Fetches latest patch date from CoD patch notes
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "warzone",
    game: "warzone",
    type: "last-patch",
    title: "Call of Duty Warzone Last Patch"
};

interface PatchInfo {
    date: Date;
    title: string;
}

export async function run(): Promise<ProviderResult> {
    const url = "https://www.callofduty.com/patchnotes";

    try {
        const response = await fetchHtml(url, { providerId: META.provider_id, timeout: 15000 });

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

        let latestPatch: PatchInfo | null = null;

        $("article, .patch-note, .card, a").each((_, elem) => {
            const $elem = $(elem);
            const text = $elem.text();

            if (!text.toLowerCase().includes("warzone")) {
                return;
            }

            const timeEl = $elem.find("time").first();
            if (timeEl.length > 0) {
                const datetime = timeEl.attr("datetime");
                if (datetime) {
                    const date = new Date(datetime);
                    if (!latestPatch || date > latestPatch.date) {
                        latestPatch = {
                            date,
                            title: $elem.find("h2, h3, .title").first().text().trim()
                        };
                    }
                }
            }

            if (!latestPatch) {
                const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})|([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/);
                if (dateMatch) {
                    const dateStr = dateMatch[1] || dateMatch[2];
                    const date = new Date(dateStr);
                    if (!isNaN(date.getTime())) {
                        latestPatch = {
                            date,
                            title: $elem.find("h2, h3").first().text().trim()
                        };
                    }
                }
            }
        });

        if (!latestPatch) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "Could not extract Warzone patch date from CoD patch notes",
                lastGood,
                response.status,
                response.mode
            );
        }

        const finalPatch = latestPatch as PatchInfo;

        return {
            ...META,
            status: "fresh",
            nextEventUtc: finalPatch.date.toISOString(),
            fetched_at_utc: new Date().toISOString(),
            source_url: url,
            confidence: Confidence.Medium,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: finalPatch.title || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
