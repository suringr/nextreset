/**
 * Roblox Service Status Provider
 * 
 * Fetches status from hostedstatus JSON API
 */

import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

const META: ProviderMetadata = {
    provider_id: "roblox",
    game: "roblox",
    type: "status",
    title: "Roblox Service Status"
};

export async function run(): Promise<ProviderResult> {
    const url = "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d";

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

        let data: any;
        try {
            data = JSON.parse(response.text);
        } catch {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "Invalid JSON in Roblox status response",
                lastGood,
                response.status,
                response.mode
            );
        }

        const status = data.result?.status_overall?.status || "unknown";
        const updated = data.result?.status_overall?.updated;

        if (!updated) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "No updated timestamp found in Roblox status JSON",
                lastGood,
                response.status,
                response.mode
            );
        }

        let updatedDate: Date;
        if (typeof updated === "number") {
            updatedDate = new Date(updated * 1000);
        } else {
            updatedDate = new Date(updated);
        }

        if (isNaN(updatedDate.getTime())) {
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                `Invalid date format in Roblox status: ${updated}`,
                lastGood,
                response.status,
                response.mode
            );
        }

        return {
            ...META,
            status: "fresh",
            nextEventUtc: updatedDate.toISOString(),
            fetched_at_utc: new Date().toISOString(),
            source_url: "https://status.roblox.com",
            confidence: Confidence.High,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: `Current status: ${status}`
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
