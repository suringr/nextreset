/**
 * Fortnite Next Season Provider
 * 
 * Fetches season end date from official Fortnite Battle Pass page
 */

import { FailureType, Confidence, ProviderResult, ProviderMetadata } from "../types";
import { fetchHtml, withBrowserPage } from "../lib/fetch-layer";
import { readLastGood, buildFallback } from "../lib/data-output";

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
            console.error(`[Fortnite] Fetch failed: ${response.error} (Status: ${response.status})`);
            const lastGood = readLastGood(META.game, META.type);
            const failureType = response.status === 403 || response.status === 429 ? FailureType.Blocked : FailureType.Unavailable;
            const reason = response.status === 403 || response.status === 429 ? "fetch_blocked" : `http_error_${response.status}`;

            return buildFallback(META, failureType, reason, lastGood, response.status, response.mode);
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

        // Broaden text source: innerText equivalent is better for visibility
        // If we are in withBrowserPage we'd use locator('body').innerText()
        // Here we just have the raw HTML/Text from fetchHtml.

        const regex = /Ends(?:\s+on)?[:\s]+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})(?:\s+(Eastern\s+Time|ET))?/i;
        const match = text.match(regex);

        if (!match) {
            console.log(`[Fortnite] No explicit end date found on page.`);
            const lastGood = readLastGood(META.game, META.type);
            return buildFallback(
                META,
                FailureType.ParseFailed,
                "no_explicit_end_date_on_page",
                lastGood,
                response.status,
                response.mode
            );
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

        // Format according to specific user request while keeping system headers
        const result: any = {
            ...META,
            provider: "fortnite", // Requested field
            currentSeasonEnds: dateStr,
            timezone: isET ? "America/New_York" : null,
            nextSeasonStart: null,
            status: "fresh",
            confidence: Confidence.High,
            reason: "",
            sourceUrl: response.url || SOURCE_URL,
            source_url: response.url || SOURCE_URL, // System compatibility
            sourceName: "Fortnite Battle Pass (Official)",
            fetched_at_utc: new Date().toISOString(),
            nextSeasonEstimate: nextSeasonEstimateStr,
            nextSeasonEstimateFriendly: nextSeasonEstimateFriendly,
            nextEventUtc: seasonEndDate.toISOString(), // System field
            http_status: response.status,
            fetch_mode: response.mode
        };

        return result as ProviderResult;

    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[Fortnite] Unexpected error: ${reason}`);
        const lastGood = readLastGood(META.game, META.type);
        return buildFallback(META, FailureType.Unavailable, reason, lastGood);
    }
}
