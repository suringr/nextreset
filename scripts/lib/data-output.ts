/**
 * Safe data output helper - handles fallback JSON creation
 */

import * as fs from "fs";
import * as path from "path";
import {
    ProviderResult,
    ProviderMetadata,
    FailureType,
    Confidence,
    FreshResult,
    StaleResult,
    FallbackResult
} from "../types";

const DATA_DIR = path.join(__dirname, "../../public/data");

/**
 * Get output path for provider data
 */
export function getOutputPath(game: string, type: string): string {
    return path.join(DATA_DIR, `${game}.${type}.json`);
}

/**
 * Ensure data directory exists
 */
export function ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Read last known good data for a provider
 */
export function readLastGood(game: string, type: string): ProviderResult | null {
    const filepath = getOutputPath(game, type);

    if (!fs.existsSync(filepath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filepath, "utf-8");
        return JSON.parse(content) as ProviderResult;
    } catch {
        return null;
    }
}

/**
 * Write provider result to JSON file
 */
export function writeJson(data: ProviderResult): void {
    ensureDataDir();
    const filepath = getOutputPath(data.game, data.type);

    // Filter out undefined and ensure order (mostly for readability/debugging)
    const cleaned = JSON.parse(JSON.stringify(data));

    fs.writeFileSync(filepath, JSON.stringify(cleaned, null, 2), "utf-8");
}

/**
 * Build fallback result when provider fails
 */
export function buildFallback(
    meta: ProviderMetadata,
    failureType: FailureType,
    explanation: string,
    lastGood: ProviderResult | null,
    httpStatus?: number,
    fetchMode?: "http" | "browser"
): ProviderResult {
    const now = new Date().toISOString();

    if (lastGood && (lastGood.status === "fresh" || lastGood.status === "stale") && lastGood.nextEventUtc) {
        // Reuse last known good data but mark as stale
        const stale: StaleResult = {
            ...meta,
            status: "stale",
            nextEventUtc: lastGood.nextEventUtc,
            last_good_at_utc: lastGood.status === "fresh" ? lastGood.fetched_at_utc : lastGood.last_good_at_utc,
            fetched_at_utc: now,
            source_url: lastGood.source_url,
            confidence: lastGood.confidence,
            reason: explanation,
            notes: (lastGood as any).notes,
            http_status: httpStatus,
            fetch_mode: fetchMode
        };
        return stale;
    }

    // No last good data - write unavailable fallback
    const fallback: FallbackResult = {
        ...meta,
        status: "fallback",
        nextEventUtc: null,
        failure_type: failureType,
        explanation: explanation,
        fetched_at_utc: now,
        http_status: httpStatus,
        fetch_mode: fetchMode
    };
    return fallback;
}

/**
 * Write provider result (success or fallback)
 */
export function writeProviderResult(result: ProviderResult): void {
    writeJson(result);
    const indicator = result.status === "fresh" ? "✓" : (result.status === "stale" ? "⚠" : "✗");
    console.log(`${indicator} Wrote ${result.game}.${result.type}.json (${result.status})`);
    if (result.status === "fallback") {
        console.log(`  Reason: ${result.failure_type} - ${result.explanation}`);
    } else if (result.status === "stale") {
        console.log(`  Stale: ${result.reason}`);
    }
}
