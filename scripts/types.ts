/**
 * Core data model for NextReset provider system
 */

export enum FailureType {
    Blocked = "blocked",
    Unavailable = "unavailable",
    ParseFailed = "parse_failed"
}

/** Precision of a published instant. "day" means the official source stated a date and no time. */
export type DatePrecision = "exact" | "day";

/** Why a value could not be refreshed, in the public vocabulary (see scripts/v2/reasons.ts). */
export type FailureReasonCode =
    | "source-unreachable"
    | "source-blocked"
    | "awaiting-verification"
    | "extraction-failed"
    | "budget-deferred"
    | "no-new-information";

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
    /**
     * Precision of `nextEventUtc`. "day" means the source states a date and no time, so a page must
     * show a date rather than a second-level countdown. Absent (V1 providers) means exact.
     */
    precision?: DatePrecision;
}

export interface StaleResult extends BaseResult {
    status: "stale";
    nextEventUtc: string;
    last_success_at_utc: string; // The fetched_at_utc of the original fresh data
    source_url: string;
    confidence: Confidence;
    /** One concise sentence for visitors; never an internal message (see scripts/v2/reasons.ts). */
    reason: string;
    /** The machine-readable kind behind `reason`. */
    reason_code?: FailureReasonCode;
    notes?: string;
    /** See FreshResult.precision. */
    precision?: DatePrecision;
}

export interface UnavailableResult extends BaseResult {
    status: "unavailable";
    nextEventUtc: null;
    failure_type: FailureType;
    /** One concise sentence for visitors; never an internal message. */
    explanation: string;
    /** The machine-readable kind behind `explanation`, when the failure had a known kind. */
    reason_code?: FailureReasonCode;
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
