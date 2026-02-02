import * as fs from "fs";
import * as path from "path";
import { ProviderResult } from "./types";
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

/**
 * Run a single provider - never throws
 */
async function runProvider(entry: ProviderEntry): Promise<{ name: string; result: ProviderResult }> {
    const startTime = Date.now();
    console.log(`\n[${new Date().toISOString()}] Running ${entry.name}...`);

    try {
        const result = await entry.run();
        const elapsed = Date.now() - startTime;

        if (result.status === "ok") {
            console.log(`✓ ${entry.name} succeeded in ${elapsed}ms`);
            console.log(`  Confidence: ${result.confidence}`);
        } else {
            console.log(`⚠ ${entry.name} using fallback (${elapsed}ms)`);
            console.log(`  Reason: ${result.reason || "unknown"}`);
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
            game: entry.name.toLowerCase().replace(/\s+/g, "-"),
            type: "unknown",
            title: entry.name,
            nextEventUtc: null,
            lastUpdatedUtc: new Date().toISOString(),
            source: null,
            confidence: "none",
            status: "unavailable",
            reason: error instanceof Error ? error.message : String(error)
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
            console.error(`❌ Fatal: Cannot write ${outcome.result.game}.${outcome.result.type}.json`);
            console.error(error);
            process.exit(1);
        }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("Summary");
    console.log("=".repeat(60));

    const freshCount = results.filter(r => r.result.status === "ok").length;
    const staleCount = results.filter(r => r.result.status === "stale").length;
    const unavailableCount = results.filter(r => r.result.status === "unavailable" || !r.result.status).length;

    console.log(`Total: ${providers.length} providers`);
    console.log(`✓ Fresh: ${freshCount}`);
    console.log(`⚠ Stale: ${staleCount}`);
    console.log(`✗ Unavailable: ${unavailableCount}`);

    // Show fallback details
    const fallbacks = results.filter(r => r.result.status !== "ok");
    if (fallbacks.length > 0) {
        console.log("\nFallback providers:");
        fallbacks.forEach(f => {
            const status = f.result.status === "stale" ? "stale" : "unavailable";
            console.log(`  - ${f.name} (${status}): ${f.result.reason || "no reason"}`);
        });
    }

    // Always exit 0 - we wrote all JSON files
    console.log(`\n✓ Refresh completed (${freshCount} fresh, ${staleCount + unavailableCount} fallback)`);
    process.exit(0);
}

// Run main
main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
});
