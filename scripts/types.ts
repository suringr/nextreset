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
    fetched_at_utc: string; // Always the current run time
    http_status?: number;
    fetch_mode?: "http" | "browser";
}

export interface FreshResult extends BaseResult {
    status: "fresh";
    nextEventUtc: string;
    source_url: string;
    confidence: Confidence;
    notes?: string;
    // For fresh results, last_success_at_utc is implied to be fetched_at_utc,
    // but we can include it explicitly or let the consumer infer it.
    // For simplicity in the Stale logic, we don't strictly need it here, 
    // but adding it makes the shape consistent.
    last_success_at_utc: string;
}

export interface StaleResult extends BaseResult {
    status: "stale";
    nextEventUtc: string;
    last_success_at_utc: string; // The fetched_at_utc of the original fresh data
    source_url: string;
    confidence: Confidence;
    reason: string;
    notes?: string;
}

export interface UnavailableResult extends BaseResult {
    status: "unavailable";
    nextEventUtc: null;
    failure_type: FailureType;
    explanation: string;
}

export type ProviderResult = FreshResult | StaleResult | UnavailableResult;

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
