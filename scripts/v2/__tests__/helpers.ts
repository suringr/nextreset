import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonKnowledgeStore } from "../store";

/** A store rooted in a fresh temporary directory. */
export function tempStore(): { store: JsonKnowledgeStore; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-knowledge-"));
    return { store: new JsonKnowledgeStore(dir), dir };
}

/** The V1 key order of a fresh GTA result (from scripts/providers/gta.ts). */
export const V1_GTA_FRESH_KEYS = [
    "provider_id", "game", "type", "title", "status", "nextEventUtc",
    "fetched_at_utc", "last_success_at_utc", "source_url", "confidence", "notes"
];

/** The V1 key order of a fresh Roblox result (from scripts/providers/roblox.ts). */
export const V1_ROBLOX_FRESH_KEYS = [
    "provider_id", "game", "type", "title", "status", "nextEventUtc",
    "fetched_at_utc", "last_success_at_utc", "source_url", "confidence",
    "http_status", "fetch_mode", "notes"
];

/** The V1 keys of an unavailable result (from scripts/refresh-all.ts). */
export const V1_UNAVAILABLE_KEYS = [
    "provider_id", "game", "type", "title", "status", "nextEventUtc",
    "failure_type", "explanation", "fetched_at_utc"
];
