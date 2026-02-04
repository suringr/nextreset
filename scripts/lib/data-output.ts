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
    UnavailableResult
} from "../types";

const LIVE_DATA_DIR = path.join(__dirname, "../../public/data");
const LKG_DATA_DIR = path.join(LIVE_DATA_DIR, "_lkg");

/**
 * Get output path for live provider data
 */
export function getLivePath(game: string, type: string): string {
    return path.join(LIVE_DATA_DIR, `${game}.${type}.json`);
}

/**
 * Get output path for LKG provider data
 */
export function getLkgPath(game: string, type: string): string {
    return path.join(LKG_DATA_DIR, `${game}.${type}.json`);
}

/**
 * Ensure data directories exist
 */
export function ensureDataDirs(): void {
    if (!fs.existsSync(LIVE_DATA_DIR)) {
        fs.mkdirSync(LIVE_DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(LKG_DATA_DIR)) {
        fs.mkdirSync(LKG_DATA_DIR, { recursive: true });
    }
}

/**
 * Read last known good data from the LKG vault
 * Returns null if missing or corrupt
 */
export function readLkgData(game: string, type: string): ProviderResult | null {
    const filepath = getLkgPath(game, type);

    if (!fs.existsSync(filepath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filepath, "utf-8");
        return JSON.parse(content) as ProviderResult;
    } catch (error) {
        console.warn(`[LKG] Corrupt LKG file found for ${game}.${type}:`, error);
        return null;
    }
}

/**
 * Write to LIVE data folder (Always called)
 */
export function writeLiveJson(data: ProviderResult): void {
    ensureDataDirs();
    const filepath = getLivePath(data.game, data.type);
    const cleaned = JSON.parse(JSON.stringify(data));
    fs.writeFileSync(filepath, JSON.stringify(cleaned, null, 2), "utf-8");

    // Log write
    const indicator = data.status === "fresh" ? "✓" : (data.status === "stale" ? "⚠" : "✗");
    console.log(`${indicator} Wrote live/${data.game}.${data.type}.json (${data.status})`);
}

/**
 * Write to LKG vault (Only called on FRESH success)
 */
export function writeLkgJson(data: ProviderResult): void {
    if (data.status !== "fresh") {
        console.warn(`[LKG] Attempted to write non-fresh data to LKG vault for ${data.game}.${data.type}`);
        return;
    }

    ensureDataDirs();
    const filepath = getLkgPath(data.game, data.type);
    const cleaned = JSON.parse(JSON.stringify(data));
    fs.writeFileSync(filepath, JSON.stringify(cleaned, null, 2), "utf-8");
    console.log(`  + Backed up to _lkg/${data.game}.${data.type}.json`);
}
