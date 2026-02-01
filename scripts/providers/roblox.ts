import fetch from "node-fetch";
import { ProviderResult } from "../types";

/**
 * Roblox Service Status Provider
 * 
 * Fetches status from hostedstatus JSON API
 */
export async function run(): Promise<ProviderResult> {
    const primaryUrl = "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d";

    try {
        const response = await fetch(primaryUrl, {
            headers: {
                "User-Agent": "NextReset/1.0 (+https://nextreset.co)",
                "Accept-Language": "en-US"
            },
            timeout: 15000
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch Roblox status: ${response.status}`);
        }

        const data = await response.json() as any;

        // Extract status and updated timestamp
        const status = data.result?.status_overall?.status || "unknown";
        const updated = data.result?.status_overall?.updated;

        if (!updated) {
            throw new Error("No updated timestamp found in Roblox status JSON");
        }

        // Parse the timestamp (assuming ISO format or Unix timestamp)
        let updatedDate: Date;

        if (typeof updated === "number") {
            updatedDate = new Date(updated * 1000); // Unix timestamp
        } else {
            updatedDate = new Date(updated);
        }

        if (isNaN(updatedDate.getTime())) {
            throw new Error(`Invalid date format in Roblox status: ${updated}`);
        }

        return {
            game: "roblox",
            type: "status",
            title: "Roblox Service Status",
            nextEventUtc: updatedDate.toISOString(),
            lastUpdatedUtc: new Date().toISOString(),
            source: {
                name: "Roblox Status Page",
                url: "https://status.roblox.com"
            },
            confidence: "high",
            notes: `Current status: ${status}`
        };
    } catch (error) {
        // Fallback: Could scrape status.roblox.com here if needed
        throw new Error(`Roblox provider failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
