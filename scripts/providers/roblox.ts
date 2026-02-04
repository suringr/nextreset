/**
 * Roblox Service Status Provider
 * 
 * Fetches status from hostedstatus JSON API
 */

import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml } from "../lib/fetch-layer";

const META: ProviderMetadata = {
    provider_id: "roblox",
    game: "roblox",
    type: "status",
    title: "Roblox Service Status"
};

export async function run(): Promise<ProviderResult> {
    const url = "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d";

    try {
        const response = await fetchHtml(url, { providerId: META.provider_id });

        if (!response.ok) {
            throw new Error(response.error || `HTTP ${response.status}`);
        }

        let data: any;
        try {
            data = JSON.parse(response.text);
        } catch {
            throw new Error("Invalid JSON in Roblox status response");
        }

        const status = data.result?.status_overall?.status || "unknown";
        const updated = data.result?.status_overall?.updated;

        if (!updated) {
            throw new Error("No updated timestamp found in Roblox status JSON");
        }

        let updatedDate: Date;
        if (typeof updated === "number") {
            updatedDate = new Date(updated * 1000);
        } else {
            updatedDate = new Date(updated);
        }

        if (isNaN(updatedDate.getTime())) {
            throw new Error(`Invalid date format in Roblox status: ${updated}`);
        }

        return {
            ...META,
            status: "fresh",
            nextEventUtc: updatedDate.toISOString(),
            fetched_at_utc: new Date().toISOString(),
            last_success_at_utc: new Date().toISOString(),
            source_url: "https://status.roblox.com",
            confidence: Confidence.High,
            http_status: response.status,
            fetch_mode: response.mode,
            notes: `Current status: ${status}`
        };
    } catch (error) {
        throw error;
    }
}
