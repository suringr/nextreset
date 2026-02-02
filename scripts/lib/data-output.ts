/**
 * Safe data output helper - handles fallback JSON creation
 */

import * as fs from "fs";
import * as path from "path";
import { ProviderResult } from "../types";

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
export function writeJson(game: string, type: string, data: ProviderResult): void {
    ensureDataDir();
    const filepath = getOutputPath(game, type);

    // Stable key order
    const ordered: ProviderResult = {
        game: data.game,
        type: data.type,
        title: data.title,
        nextEventUtc: data.nextEventUtc,
        lastUpdatedUtc: data.lastUpdatedUtc,
        source: data.source,
        confidence: data.confidence,
        status: data.status,
        reason: data.reason,
        notes: data.notes,
        lastGood: data.lastGood
    };

    // Remove undefined fields
    const cleaned = JSON.parse(JSON.stringify(ordered));

    fs.writeFileSync(filepath, JSON.stringify(cleaned, null, 2), "utf-8");
}

/**
 * Provider info for fallback generation
 */
export interface ProviderMeta {
    game: string;
    type: string;
    title: string;
}

/**
 * Build fallback result when provider fails
 */
export function buildFallback(
    meta: ProviderMeta,
    reason: string,
    lastGood: ProviderResult | null
): ProviderResult {
    const now = new Date().toISOString();

    if (lastGood && lastGood.nextEventUtc) {
        // Reuse last known good data but mark as stale
        return {
            game: meta.game,
            type: meta.type,
            title: meta.title,
            nextEventUtc: lastGood.nextEventUtc,
            lastUpdatedUtc: now,
            source: lastGood.source,
            confidence: lastGood.confidence === "none" ? "low" : lastGood.confidence,
            status: "stale",
            reason,
            notes: lastGood.notes,
            lastGood: {
                nextEventUtc: lastGood.nextEventUtc,
                lastUpdatedUtc: lastGood.lastUpdatedUtc
            }
        };
    }

    // No last good data - write unavailable fallback
    return {
        game: meta.game,
        type: meta.type,
        title: meta.title,
        nextEventUtc: null,
        lastUpdatedUtc: now,
        source: null,
        confidence: "none",
        status: "unavailable",
        reason
    };
}

/**
 * Write provider result (success or fallback)
 */
export function writeProviderResult(result: ProviderResult): void {
    writeJson(result.game, result.type, result);
    const status = result.status === "ok" ? "✓" : "⚠";
    console.log(`${status} Wrote ${result.game}.${result.type}.json`);
}
