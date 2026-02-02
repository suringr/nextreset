/**
 * Roblox Service Status Provider
 * 
 * Fetches status from hostedstatus JSON API
 */

import { ProviderResult, ProviderMeta } from "../types";
import { fetchWithRetry } from "../lib/http";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMeta = {
    game: "roblox",
    type: "status",
    title: "Roblox Service Status"
};

export async function run(): Promise<ProviderResult> {
    const url = "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d";

    try {
        const response = await fetchWithRetry(url);

        if (!response.ok) {
            const reason = response.error || `HTTP ${response.status}`;
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Failed to fetch Roblox status: ${reason}`, lastGood);
        }

        let data: any;
        try {
            data = JSON.parse(response.text);
        } catch {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "Invalid JSON in Roblox status response", lastGood);
        }

        const status = data.result?.status_overall?.status || "unknown";
        const updated = data.result?.status_overall?.updated;

        if (!updated) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, "No updated timestamp found in Roblox status JSON", lastGood);
        }

        let updatedDate: Date;
        if (typeof updated === "number") {
            updatedDate = new Date(updated * 1000);
        } else {
            updatedDate = new Date(updated);
        }

        if (isNaN(updatedDate.getTime())) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(META, `Invalid date format in Roblox status: ${updated}`, lastGood);
        }

        return {
            game: META.game,
            type: META.type,
            title: META.title,
            nextEventUtc: updatedDate.toISOString(),
            lastUpdatedUtc: new Date().toISOString(),
            source: {
                name: "Roblox Status Page",
                url: "https://status.roblox.com"
            },
            confidence: "high",
            status: "ok",
            notes: `Current status: ${status}`
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, reason, lastGood);
    }
}
