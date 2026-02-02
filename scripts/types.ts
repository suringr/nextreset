/**
 * Core data model for NextReset provider system
 */

export enum FailureType {
    Blocked = "blocked",
    Unavailable = "unavailable",
    ParseFailed = "parse_failed"
}

export enum Confidence {
    High = "high",
    Medium = "medium",
    Low = "low",
    None = "none"
}

export interface ProviderMetadata {
    provider_id: string;
    game: string;
    type: string;
    title: string;
}

export interface BaseResult extends ProviderMetadata {
    fetched_at_utc: string;
    http_status?: number;
    fetch_mode?: "http" | "browser";
}

export interface FreshResult extends BaseResult {
    status: "fresh";
    nextEventUtc: string; // Must have a date
    source_url: string;
    confidence: Confidence;
    notes?: string;
}

export interface StaleResult extends BaseResult {
    status: "stale";
    nextEventUtc: string;
    last_good_at_utc: string;
    source_url: string;
    confidence: Confidence;
    reason: string;
    notes?: string;
}

export interface FallbackResult extends BaseResult {
    status: "fallback";
    nextEventUtc: null;
    failure_type: FailureType;
    explanation: string;
}

export type ProviderResult = FreshResult | StaleResult | FallbackResult;

/**
 * Provider function signature
 */
export type Provider = () => Promise<ProviderResult>;

/**
 * Legacy metadata for backward compatibility during migration
 */
export interface ProviderMeta {
    game: string;
    type: string;
    title: string;
}
