import { FailureType, ProviderResult, StaleResult, UnavailableResult, Provider } from "./types";
import { writeLiveJson, writeLkgJson, readLkgData, ensureDataDirs } from "./lib/data-output";

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

/**
 * Provider Registry
 * explicit metadata allows LKG lookups even if provider crashes
 */
interface RegistryEntry {
    id: string;
    type: string;
    name: string;
    run: Provider;
}

const REGISTRY: RegistryEntry[] = [
    { id: "fortnite", type: "next-season", name: "Fortnite", run: fortnite.run },
    { id: "lol", type: "next-patch", name: "League of Legends", run: lol.run },
    { id: "valorant", type: "last-patch", name: "VALORANT", run: valorant.run },
    { id: "cs2", type: "last-update", name: "Counter-Strike 2", run: cs2.run },
    { id: "minecraft", type: "last-release", name: "Minecraft", run: minecraft.run },
    { id: "roblox", type: "status", name: "Roblox", run: roblox.run },
    { id: "gta", type: "weekly-reset", name: "GTA Online", run: gta.run },
    { id: "warzone", type: "last-patch", name: "Warzone", run: warzone.run },
    { id: "genshin", type: "next-banner", name: "Genshin Impact", run: genshin.run },
    { id: "pubg", type: "last-patch", name: "PUBG", run: pubg.run },
    { id: "red-dead-redemption-2", type: "last-update", name: "Red Dead Redemption 2", run: rdr2.run },
    { id: "ea-sports-fc", type: "last-title-update", name: "EA SPORTS FC", run: eafc.run }
];

async function main() {
    console.log("=".repeat(60));
    console.log("NextReset Data Refresh (LKG Enabled)");
    console.log("=".repeat(60));

    try {
        ensureDataDirs();
    } catch (error) {
        console.error("❌ Fatal: Cannot create data directories");
        console.error(error);
        process.exit(1);
    }

    const results: ProviderResult[] = [];

    // Run providers sequentially
    for (const entry of REGISTRY) {
        const startTime = Date.now();
        console.log(`\n[${new Date().toISOString()}] Running ${entry.name}...`);

        let result: ProviderResult;

        try {
            // 1. Attempt Fresh Run
            result = await entry.run();

            // Validate result shape (providers might return Partial internally, but we expect ProviderResult)
            if (!result || !result.status) {
                throw new Error("Provider returned invalid/empty result");
            }

        } catch (error) {
            // 2. Catch Crash -> Create Unavailable (temp) -> Fallback Logic will handle logic below
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`✗ ${entry.name} crashed: ${reason}`);

            result = {
                provider_id: entry.id,
                game: entry.id,
                type: entry.type,
                title: entry.name,
                status: "unavailable",
                nextEventUtc: null,
                failure_type: FailureType.Unavailable,
                explanation: `Crashed: ${reason}`,
                fetched_at_utc: new Date().toISOString()
            };
        }

        const elapsed = Date.now() - startTime;

        // 3. Global LKG Safety Net
        if (result.status === "fresh") {
            // Success!
            console.log(`✓ ${entry.name} succeeded in ${elapsed}ms`);

            // Explicit Dual-Write
            writeLiveJson(result);
            writeLkgJson(result);

        } else {
            // Failed (Unavailable from crash OR explicit 'unavailable' from provider)
            // Attempt to recover using LKG
            const lkg = readLkgData(entry.id, entry.type);

            if (lkg && lkg.status === "fresh") {
                // RECOVERY: Downgrade to Stale
                const staleResult: StaleResult = {
                    ...lkg,
                    status: "stale",
                    fetched_at_utc: new Date().toISOString(), // Current run
                    last_success_at_utc: lkg.fetched_at_utc, // Original success
                    reason: result.status === "unavailable" ? result.explanation : (result as StaleResult).reason || "Unknown failure",
                    provider_id: entry.id,
                    game: entry.id,
                    type: entry.type,
                    title: entry.name
                };

                console.warn(`⚠ ${entry.name} failed but recovered with LKG data (${elapsed}ms)`);
                console.warn(`  Reason: ${staleResult.reason}`);

                result = staleResult;
                writeLiveJson(staleResult); // Only write live, NEVER overwrite LKG with stale

            } else {
                // CATASTROPHE: No LKG available
                console.error(`✗ ${entry.name} failed and NO LKG data found (${elapsed}ms)`);

                // Ensure result is marked unavailable
                if (result.status !== "unavailable") {
                    // Should not really happen if we follow types, but ensure shape
                    result = {
                        provider_id: entry.id,
                        game: entry.id,
                        type: entry.type,
                        title: entry.name,
                        status: "unavailable",
                        nextEventUtc: null,
                        failure_type: FailureType.Unavailable,
                        explanation: (result as any).reason || "Unknown failure",
                        fetched_at_utc: new Date().toISOString()
                    };
                }

                writeLiveJson(result);
            }
        }

        results.push(result);
    }

    // Summary & Exit Logic
    console.log("\n" + "=".repeat(60));
    console.log("Summary");
    console.log("=".repeat(60));

    const freshCount = results.filter(r => r.status === "fresh").length;
    const staleCount = results.filter(r => r.status === "stale").length;
    const unavailableCount = results.filter(r => r.status === "unavailable").length;
    const total = results.length;

    console.log(`Total: ${total}`);
    console.log(`✓ Fresh: ${freshCount}`);
    console.log(`⚠ Stale (LKG): ${staleCount}`);
    console.log(`✗ Unavailable: ${unavailableCount}`);

    if (unavailableCount > 0) {
        console.log("\nUnavailable Providers:");
        results.filter(r => r.status === "unavailable").forEach(r => {
            console.log(`  - ${r.title}: ${(r as UnavailableResult).explanation}`);
        });
    }

    // Exit Code Logic
    // Fail only if > 50% are unavailable (catastrophic)
    // 0 unavailable = Perfect/Safe (Exit 0)
    const failureRatio = total > 0 ? unavailableCount / total : 0;

    if (failureRatio > 0.5) {
        console.error(`\n❌ Catastrophic failure: ${unavailableCount}/${total} providers unavailable.`);
        process.exit(1);
    } else {
        console.log(`\n✓ Refresh completed successfully.`);
        process.exit(0);
    }
}

main().catch(error => {
    console.error("Fatal orchestrator error:", error);
    process.exit(1);
});
