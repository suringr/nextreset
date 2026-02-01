import * as fs from "fs";
import * as path from "path";
import { ProviderResult } from "./types";

/**
 * Orchestration script for NextReset
 * 
 * Runs all providers, writes JSON files, and handles failures gracefully
 */

// Import all providers
import * as fortnite from "./providers/fortnite";
import * as lol from "./providers/lol";
import * as valorant from "./providers/valorant";
import * as cs2 from "./providers/cs2";
import * as minecraft from "./providers/minecraft";
import * as roblox from "./providers/roblox";
import * as gta from "./providers/gta";
import * as warzone from "./providers/warzone";
import * as genshin from "./providers/genshin";
import * as pubg from "./providers/pubg";

interface ProviderEntry {
    name: string;
    run: () => Promise<ProviderResult>;
}

const providers: ProviderEntry[] = [
    { name: "Fortnite", run: fortnite.run },
    { name: "League of Legends", run: lol.run },
    { name: "VALORANT", run: valorant.run },
    { name: "Counter-Strike 2", run: cs2.run },
    { name: "Minecraft", run: minecraft.run },
    { name: "Roblox", run: roblox.run },
    { name: "GTA Online", run: gta.run },
    { name: "Warzone", run: warzone.run },
    { name: "Genshin Impact", run: genshin.run },
    { name: "PUBG", run: pubg.run }
];

const DATA_DIR = path.join(__dirname, "../public/data");

/**
 * Ensure data directory exists
 */
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Write provider result to JSON file
 */
function writeProviderData(result: ProviderResult): void {
    const filename = `${result.game}.${result.type}.json`;
    const filepath = path.join(DATA_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`✓ Wrote ${filename}`);
}

/**
 * Check if JSON file exists for a provider result
 */
function jsonExists(game: string, type: string): boolean {
    const filename = `${game}.${type}.json`;
    const filepath = path.join(DATA_DIR, filename);
    return fs.existsSync(filepath);
}

/**
 * Run a single provider with error handling
 */
async function runProvider(entry: ProviderEntry): Promise<{ success: boolean; result?: ProviderResult; error?: Error }> {
    const startTime = Date.now();
    console.log(`\n[${new Date().toISOString()}] Running ${entry.name}...`);

    try {
        const result = await entry.run();
        const elapsed = Date.now() - startTime;
        console.log(`✓ ${entry.name} succeeded in ${elapsed}ms`);
        console.log(`  Confidence: ${result.confidence}`);

        return { success: true, result };
    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.error(`✗ ${entry.name} failed after ${elapsed}ms`);
        console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);

        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/**
 * Main orchestration function
 */
async function main() {
    console.log("=".repeat(60));
    console.log("NextReset Data Refresh");
    console.log("=".repeat(60));

    ensureDataDir();

    const results: { name: string; success: boolean; hasFallback: boolean }[] = [];

    // Run providers sequentially to avoid rate limiting
    for (const provider of providers) {
        const outcome = await runProvider(provider);

        if (outcome.success && outcome.result) {
            // Success: write the data
            writeProviderData(outcome.result);
            results.push({ name: provider.name, success: true, hasFallback: true });
        } else {
            // Failure: check if we have existing JSON
            // We need to infer game/type from provider name (or we could track it differently)
            // For now, we'll mark as failure and check existence later

            const hasFallback = false; // We'll need to check this properly
            results.push({ name: provider.name, success: false, hasFallback });
        }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("Summary");
    console.log("=".repeat(60));

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    const missingData = results.filter(r => !r.success && !r.hasFallback);

    console.log(`Total: ${providers.length} providers`);
    console.log(`✓ Success: ${successCount}`);
    console.log(`✗ Failed: ${failureCount}`);

    if (missingData.length > 0) {
        console.log(`\n⚠ Missing data (no fallback):`);
        missingData.forEach(r => console.log(`  - ${r.name}`));
    }

    // Exit policy:
    // Exit 1 if any provider is missing JSON (no fallback data)
    // Exit 0 if at least one provider succeeded

    if (missingData.length > 0) {
        console.error(`\n❌ Exiting with error: ${missingData.length} provider(s) have no data`);
        process.exit(1);
    }

    if (successCount === 0) {
        console.error(`\n❌ Exiting with error: No providers succeeded`);
        process.exit(1);
    }

    console.log(`\n✓ Refresh completed successfully`);
    process.exit(0);
}

// Run main
main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
});
