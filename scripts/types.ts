/**
 * Core data model for NextReset provider system
 */

export interface ProviderResult {
    /** Game identifier (lowercase, kebab-case, e.g., "fortnite", "gta") */
    game: string;

    /** Event type (e.g., "next-season", "next-patch", "weekly-reset", "last-update", "status") */
    type: string;

    /** Human-readable title */
    title: string;

    /** 
     * ISO 8601 UTC timestamp (reference timestamp)
     * - For future events: timestamp when event occurs
     * - For last-update pages: timestamp when last updated
     */
    nextEventUtc: string;

    /** ISO 8601 UTC timestamp of when this data was fetched */
    lastUpdatedUtc: string;

    /** Source attribution */
    source: {
        name: string;
        url: string;
    };

    /** Confidence level in the data accuracy */
    confidence: "high" | "medium" | "low";

    /** Optional additional context or notes */
    notes?: string;
}

/**
 * Provider function signature
 * Each provider implements this interface to fetch and normalize game data
 */
export type Provider = () => Promise<ProviderResult>;
