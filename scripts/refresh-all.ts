import { ProviderResult, FailureType } from "./types";
import { writeProviderResult, ensureDataDir } from "./lib/data-output";

/**
 * Orchestration script for NextReset
 * 
 * Runs all providers, writes JSON files, and NEVER exits non-zero
 * due to provider failures. Only exits 1 for programmer errors.
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
import * as rdr2 from "./providers/rdr2";
import * as eafc from "./providers/eafc";

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
    { name: "PUBG", run: pubg.run },
    { name: "Red Dead Redemption 2", run: rdr2.run },
    { name: "EA SPORTS FC", run: eafc.run }
];

/**
 * Run a single provider - never throws
 */
async function runProvider(entry: ProviderEntry): Promise<{ name: string; result: ProviderResult }> {
    const startTime = Date.now();
    console.log(`\n[${new Date().toISOString()}] Running ${entry.name}...`);

    try {
        const result = await entry.run();
        const elapsed = Date.now() - startTime;

        const modeStr = result.fetch_mode ? ` [${result.fetch_mode.toUpperCase()}]` : "";
        const statusStr = result.http_status ? ` (HTTP ${result.http_status})` : "";

        if (result.status === "fresh") {
            console.log(`✓ ${entry.name} succeeded in ${elapsed}ms${modeStr}${statusStr}`);
            console.log(`  Confidence: ${result.confidence}`);
        } else if (result.status === "stale") {
            console.log(`⚠ ${entry.name} using stale data (${elapsed}ms)${modeStr}${statusStr}`);
            console.log(`  Reason: ${result.reason}`);
        } else {
            console.log(`✗ ${entry.name} failed (${elapsed}ms)${modeStr}${statusStr}`);
            console.log(`  Failure: ${result.failure_type} - ${result.explanation}`);
        }

        return { name: entry.name, result };
    } catch (error) {
        // This should never happen since providers now never throw
        // But just in case, create an emergency fallback
        const elapsed = Date.now() - startTime;
        console.error(`✗ ${entry.name} unexpected error after ${elapsed}ms`);
        console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);

        // Create minimal fallback
        const result: ProviderResult = {
            provider_id: entry.name.toLowerCase().replace(/\s+/g, "-"),
            game: entry.name.toLowerCase().replace(/\s+/g, "-"),
            type: "unknown",
            title: entry.name,
            status: "fallback",
            nextEventUtc: null,
            failure_type: FailureType.Unavailable,
            explanation: error instanceof Error ? error.message : String(error),
            fetched_at_utc: new Date().toISOString()
        };

        return { name: entry.name, result };
    }
}

/**
 * Main orchestration function - always exits 0 for provider issues
 */
async function main() {
    console.log("=".repeat(60));
    console.log("NextReset Data Refresh");
    console.log("=".repeat(60));

    try {
        ensureDataDir();
    } catch (error) {
        // This IS a programmer error - can't write files
        console.error("❌ Fatal: Cannot create data directory");
        console.error(error);
        process.exit(1);
    }

    const results: { name: string; result: ProviderResult }[] = [];

    // Run providers sequentially to avoid rate limiting
    for (const provider of providers) {
        const outcome = await runProvider(provider);
        results.push(outcome);

        // Write result (success or fallback)
        try {
            writeProviderResult(outcome.result);
        } catch (error) {
            // This IS a programmer error - can't write files
            console.error(`❌ Fatal: Cannot write result for ${outcome.name}`);
            console.error(error);
            process.exit(1);
        }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("Summary");
    console.log("=".repeat(60));

    const freshCount = results.filter(r => r.result.status === "fresh").length;
    const staleCount = results.filter(r => r.result.status === "stale").length;
    const fallbackCount = results.filter(r => r.result.status === "fallback").length;

    console.log(`Total: ${providers.length} providers`);
    console.log(`✓ Fresh: ${freshCount}`);
    console.log(`⚠ Stale: ${staleCount}`);
    console.log(`✗ Fallback: ${fallbackCount}`);

    // Show fallback details
    const fallbacks = results.filter(r => r.result.status === "fallback") as { name: string; result: Extract<ProviderResult, { status: "fallback" }> }[];
    if (fallbacks.length > 0) {
        console.log("\nFallback providers:");
        fallbacks.forEach(f => {
            console.log(`  - ${f.name}: [${f.result.failure_type}] ${f.result.explanation}`);
        });
    }

    // Always exit 0 - we wrote all JSON files
    console.log(`\n✓ Refresh completed (${freshCount} fresh, ${staleCount + fallbackCount} fallback/stale)`);
    process.exit(0);
}

// Run main
main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
});
