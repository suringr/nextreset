/**
 * Fortnite Next Season Provider
 * 
 * Fetches season end date from official Fortnite Battle Pass page
 */

import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml, withBrowserPage } from "../lib/fetch-layer";

const META: ProviderMetadata = {
    provider_id: "fortnite",
    game: "fortnite",
    type: "next-season",
    title: "Fortnite Season End"
};

const SOURCE_URL = "https://www.fortnite.com/battle-pass";

// Months map for deterministic parsing
const MONTH_MAP: Record<string, number> = {
    'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
    'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
};

export async function run(): Promise<ProviderResult> {
    try {
        console.log(`[Fortnite] Fetching ${SOURCE_URL}...`);

        // Use fetchHtml with browser fallback
        const response = await fetchHtml(SOURCE_URL, {
            providerId: META.provider_id,
            useBrowserOnBlocked: true,
            timeout: 30000
        });

        if (!response.ok) {
            // Throwing triggers orchestrator's LKG fallback
            throw new Error(`Fetch failed: ${response.error} (Status: ${response.status})`);
        }

        let text = response.text;
        if (response.mode === "browser" || response.text.includes("<html")) {
            // Light HTML -> Text strip
            text = response.text
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
                .replace(/<[^>]*>?/gm, " ")
                .replace(/\s+/g, " ")
                .trim();
        }

        const regex = /Ends(?:\s+on)?[:\s]+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})(?:\s+(Eastern\s+Time|ET))?/i;
        const match = text.match(regex);

        if (!match) {
            throw new Error("No explicit end date found on page");
        }

        const matchedText = match[0];
        const datePart = match[1];
        const isET = !!match[2];

        console.log(`[Fortnite] Matched text: "${matchedText}"`);

        // Deterministic Parsing
        const dateMatch = datePart.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
        if (!dateMatch) {
            throw new Error(`Failed to parse date parts from: ${datePart}`);
        }

        const monthName = dateMatch[1].toLowerCase();
        const day = parseInt(dateMatch[2], 10);
        const year = parseInt(dateMatch[3], 10);
        const monthIndex = MONTH_MAP[monthName];

        if (monthIndex === undefined) {
            throw new Error(`Unknown month: ${monthName}`);
        }

        // Construct date at midnight UTC for stability
        const seasonEndDate = new Date(Date.UTC(year, monthIndex, day, 0, 0, 0));
        const dateStr = seasonEndDate.toISOString().split('T')[0];

        // Calculate next season estimate (End + 1)
        const nextSeasonEstimate = new Date(seasonEndDate);
        nextSeasonEstimate.setUTCDate(seasonEndDate.getUTCDate() + 1);
        const nextSeasonEstimateStr = nextSeasonEstimate.toISOString().split('T')[0];
        const nextSeasonEstimateFriendly = nextSeasonEstimate.toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric'
        });

        // Return FRESH result
        // Orchestrator handles writing to _lkg
        const result: ProviderResult = {
            ...META,
            status: "fresh",
            fetched_at_utc: new Date().toISOString(),
            last_success_at_utc: new Date().toISOString(), // Fresh = now
            nextEventUtc: seasonEndDate.toISOString(),
            source_url: response.url || SOURCE_URL,
            confidence: Confidence.High,
            http_status: response.status,
            fetch_mode: response.mode,

            // Custom fields (preserved in type assertion)
            ...{
                currentSeasonEnds: dateStr,
                timezone: isET ? "America/New_York" : null,
                nextSeasonStart: null,
                nextSeasonEstimate: nextSeasonEstimateStr,
                nextSeasonEstimateFriendly: nextSeasonEstimateFriendly,
                sourceName: "Fortnite Battle Pass (Official)",
                provider: "fortnite",
            }
        };

        return result;

    } catch (error) {
        // Re-throw to let orchestrator handle LKG
        throw error;
    }
}
