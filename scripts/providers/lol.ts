/**
 * League of Legends Next Patch Provider
 * 
 * Fetches next patch date from Riot's official patch schedule
 */

import * as cheerio from "cheerio";
import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";

const META: ProviderMetadata = {
    provider_id: "lol",
    game: "lol",
    type: "next-patch",
    title: "League of Legends Next Patch"
};

interface PatchInfo {
    date: Date;
    patchName: string;
}

export async function run(): Promise<ProviderResult> {
    const url = "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/360018987893-League-of-Legends-Patch-Schedule";

    try {
        const response = await fetchHtml(url, { providerId: META.provider_id, useBrowserOnBlocked: true });

        if (!response.ok) {
            throw new Error(response.error || `HTTP ${response.status}`);
        }

        const $ = cheerio.load(response.text);
        $("script, style, noscript").remove();

        const finalSourceUrl = response.url || url;
        const now = new Date();
        // Create a date for "today at midnight UTC" to avoid rejecting today's patches
        const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        let bestPatch: PatchInfo | null = null;

        // Strictly target the schedule table
        const table = $("table").first();
        if (table.length > 0) {
            table.find("tr").each((_, tr) => {
                const cells = $(tr).find("td");
                if (cells.length >= 2) {
                    const patchName = $(cells[0]).text().trim();
                    const dateStr = $(cells[1]).text().trim();

                    if (patchName && dateStr) {
                        // Extract date from string like "Wednesday, Jan 10, 2024" or just "Jan 10, 2024"
                        const dateMatch = dateStr.match(/([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/);
                        if (dateMatch) {
                            const parsedDate = new Date(dateMatch[1]);

                            if (!isNaN(parsedDate.getTime())) {
                                // Date Validation Guardrail (already somewhat covered by schedule logic)
                                const twoYearsAgo = new Date();
                                twoYearsAgo.setFullYear(now.getFullYear() - 2);
                                const twoYearsFuture = new Date();
                                twoYearsFuture.setFullYear(now.getFullYear() + 2);

                                if (parsedDate >= twoYearsAgo && parsedDate <= twoYearsFuture) {
                                    // select the first date that is >= today (UTC)
                                    if (parsedDate >= todayUtc && (!bestPatch || parsedDate < bestPatch.date)) {
                                        bestPatch = { date: parsedDate, patchName };
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }

        if (!bestPatch) {
            throw new Error(`Could not find upcoming patch date in schedule table. Source: ${finalSourceUrl}`);
        }

        const finalPatch = bestPatch as PatchInfo;

        return {
            ...META,
            status: "fresh",
            nextEventUtc: finalPatch.date.toISOString(),
            fetched_at_utc: now.toISOString(),
            last_success_at_utc: now.toISOString(),
            source_url: finalSourceUrl,
            confidence: Confidence.High,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: finalPatch.patchName ? `Patch ${finalPatch.patchName}` : undefined
        };
    } catch (error) {
        throw error;
    }
}
