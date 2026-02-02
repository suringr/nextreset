/**
 * Call of Duty Warzone Last Patch Provider
 * 
 * Fetches latest patch date from CoD patch notes
 */

import * as cheerio from "cheerio";
import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
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
        const response = await fetchWithRetry(url, { timeout: 15000 });

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch Warzone patch notes: ${reason}`, lastGood);
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
            return buildFallback(META, "Could not extract Warzone patch date from CoD patch notes", lastGood);
        }

        // TypeScript needs explicit access after null check with callbacks
        const result: PatchInfo = latestPatch;

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: result.date.toISOString(),
            lastUpdatedUtc: new Date().toISOString(),
            source: {
                name: "Call of Duty - Patch Notes",
                url: url
            },
            confidence: "medium",
            status: "ok",
            notes: result.title || undefined
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
