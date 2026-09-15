import * as fs from "fs";
import { FailureType, ProviderResult, StaleResult, UnavailableResult, Provider } from "./types";
import { writeLiveJson, writeLkgJson, readLkgData, ensureDataDirs } from "./lib/data-output";
import { JsonKnowledgeStore } from "./v2/store";
import { runV2Tracker } from "./v2/pipeline";
import { AiGate } from "./v2/cost/budget";
import { TrackerCostLine, createRunAiGate, renderRunSummary, summarizeRun } from "./v2/cost/run";

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
 *
 * engine "v1": legacy provider (run) + LKG vault fallback.
 * engine "v2": scripts/v2 pipeline (adapter -> KnowledgeStore -> compatible view);
 *              `run` is kept only as the rollback path (flip the engine back to "v1").
 */
type Engine = "v1" | "v2";

interface RegistryEntry {
    id: string;
    type: string;
    name: string;
    engine: Engine;
    run: Provider;
}

const REGISTRY: RegistryEntry[] = [
    { id: "fortnite", type: "next-season", name: "Fortnite", engine: "v1", run: fortnite.run },
    { id: "lol", type: "next-patch", name: "League of Legends", engine: "v2", run: lol.run },
    { id: "valorant", type: "last-patch", name: "VALORANT", engine: "v1", run: valorant.run },
    { id: "cs2", type: "last-update", name: "Counter-Strike 2", engine: "v1", run: cs2.run },
    { id: "minecraft", type: "last-release", name: "Minecraft", engine: "v1", run: minecraft.run },
    { id: "roblox", type: "status", name: "Roblox", engine: "v2", run: roblox.run },
    { id: "gta", type: "weekly-reset", name: "GTA Online", engine: "v2", run: gta.run },
    { id: "warzone", type: "last-patch", name: "Warzone", engine: "v1", run: warzone.run },
    { id: "genshin", type: "next-banner", name: "Genshin Impact", engine: "v1", run: genshin.run },
    { id: "pubg", type: "last-patch", name: "PUBG", engine: "v1", run: pubg.run },
    { id: "red-dead-redemption-2", type: "last-update", name: "Red Dead Redemption 2", engine: "v1", run: rdr2.run },
    { id: "ea-sports-fc", type: "last-title-update", name: "EA SPORTS FC", engine: "v1", run: eafc.run }
];

/**
 * V1 fail-safe: rebuild a stale result from the LKG vault, or null when the
 * vault has nothing usable for this tracker.
 */
function staleFromLkg(entry: RegistryEntry, reason: string): StaleResult | null {
    const lkg = readLkgData(entry.id, entry.type);
    if (!lkg || lkg.status !== "fresh") return null;
    return {
        ...lkg,
        status: "stale",
        fetched_at_utc: new Date().toISOString(), // Current run
        last_success_at_utc: lkg.fetched_at_utc, // Original success
        reason,
        provider_id: entry.id,
        game: entry.id,
        type: entry.type,
        title: entry.name
    };
}

/**
 * V2 path: adapter -> KnowledgeStore -> V1-compatible view.
 * Fallback to previously stored knowledge happens inside the pipeline. During
 * the migration the V1 LKG vault is still kept current on success and consulted
 * as a last resort, so an empty or unavailable knowledge branch never makes a
 * tracker less resilient than it was on V1.
 */
/** One-line summaries of what an evidence-based adapter did (sources, discovery, AI usage); never secrets. */
function logAdapterReport(entry: RegistryEntry, report: Record<string, unknown> | undefined): void {
    if (!report) return;
    const attempts = report.attempts as Array<{ url: string; via: string; outcome: string; reason?: string }> | undefined;
    for (const a of attempts ?? []) console.log(`  [${entry.id}] ${a.via} ${a.url} -> ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`);
    const decision = report.decision as { discover: boolean; reason: string } | undefined;
    if (decision) console.log(`  [${entry.id}] discovery ${decision.discover ? "ran" : "skipped"}: ${decision.reason}`);
    const discovery = report.discovery as { queries: Array<{ provider: string; query: string; results: number; error?: string }>; searchedWeb: boolean; unavailable: string[] } | undefined;
    if (discovery) {
        for (const q of discovery.queries) console.log(`  [${entry.id}] search [${q.provider}] "${q.query}" -> ${q.results}${q.error ? ` (${q.error})` : ""}`);
        if (discovery.unavailable.length > 0) console.log(`  [${entry.id}] search unavailable: ${discovery.unavailable.join(", ")}`);
    }
    const winner = report.winner as { url: string; via: string } | undefined;
    const confidence = report.confidence as { level: string; reasons: string[] } | undefined;
    if (winner) console.log(`  [${entry.id}] answered by ${winner.url} (via ${winner.via})${confidence ? `, confidence ${confidence.level}` : ""}`);
    const ai = report.ai as { model?: string; calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd?: number } | undefined;
    if (ai && ai.calls > 0) console.log(`  [${entry.id}] AI ${ai.model ?? ""}: ${ai.calls} call(s), ${ai.inputTokens} in / ${ai.outputTokens} out tokens${ai.estimatedCostUsd !== undefined ? `, est. $${ai.estimatedCostUsd.toFixed(4)}` : ""}`);
}

const escapeAnnotation = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

async function runV2(entry: RegistryEntry, store: JsonKnowledgeStore, startTime: number, gate: AiGate): Promise<{ result: ProviderResult; line: TrackerCostLine }> {
    let result: ProviderResult;
    let detail = "";
    const line: TrackerCostLine = { game: entry.id, type: entry.type, engine: "v2", status: "unavailable" };
    try {
        const run = await runV2Tracker(entry.id, entry.type, store, new Date(), { ai: gate });
        result = run.result;
        detail = `${run.created} new event(s), ${run.changes.length} change(s)`;
        logAdapterReport(entry, run.report);
        line.work = run.work;
        const decision = (run.report as { decision?: { discover: boolean; reason: string } } | undefined)?.decision;
        if (decision) line.discovery = `${decision.discover ? "ran" : "skipped"}: ${decision.reason}`;
        if (run.deferred) {
            line.deferred = run.deferred.detail;
            console.warn(`  [${entry.id}] deferred_due_to_budget: ${run.deferred.detail}`);
            if (process.env.GITHUB_ACTIONS === "true") {
                console.log(`::warning title=AI work deferred::${escapeAnnotation(`${entry.name} (${entry.id}.${entry.type}): ${run.deferred.detail}. Stored knowledge is served; a later run retries.`)}`);
            }
        }
        if (run.saveError && process.env.GITHUB_ACTIONS === "true") {
            console.log(`::warning title=Knowledge not saved::${entry.name} (${entry.id}.${entry.type}): ${run.saveError.replace(/[\r\n]+/g, " ")}`);
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result = {
            provider_id: entry.id,
            game: entry.id,
            type: entry.type,
            title: entry.name,
            status: "unavailable",
            nextEventUtc: null,
            failure_type: FailureType.Unavailable,
            explanation: `Crashed (v2): ${reason}`,
            fetched_at_utc: new Date().toISOString()
        };
    }

    if (result.status === "unavailable") {
        const fallback = staleFromLkg(entry, result.explanation);
        if (fallback) {
            console.warn(`⚠ ${entry.name}: no usable stored knowledge; recovered with V1 LKG data`);
            result = fallback;
        }
    }

    const elapsed = Date.now() - startTime;
    if (result.status === "fresh") {
        console.log(`✓ ${entry.name} succeeded in ${elapsed}ms [v2: ${detail}]`);
        writeLkgJson(result); // keep the V1 vault current as the migration-time last resort
    } else if (result.status === "stale") {
        console.warn(`⚠ ${entry.name} failed but served stored knowledge (${elapsed}ms)`);
        console.warn(`  Reason: ${result.reason}`);
    } else {
        console.error(`✗ ${entry.name} unavailable (${elapsed}ms): ${result.explanation}`);
    }

    writeLiveJson(result);
    line.status = result.status;
    return { result, line };
}

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
    const store = new JsonKnowledgeStore();
    console.log(`Knowledge store: ${store.rootDir}`);

    // One AI budget for the whole run; its usage ledger lives in the knowledge store so limits hold across the day's runs.
    const runStartedAt = new Date();
    const { gate, unavailable } = createRunAiGate({ knowledgeRoot: store.rootDir, now: runStartedAt });
    console.log(`AI budget (estimates, per UTC day): $${gate.limits.dailyCostUsd.toFixed(2)}, ${gate.limits.dailyCalls} calls, ${gate.limits.perTopicCalls} calls per topic; ledger ${gate.ledger.location}`);
    if (unavailable) console.warn(`⚠ No AI calls this run: ${unavailable}`);
    const costLines: TrackerCostLine[] = [];

    // Run providers sequentially
    for (const entry of REGISTRY) {
        const startTime = Date.now();
        console.log(`\n[${new Date().toISOString()}] Running ${entry.name} [${entry.engine}]...`);

        if (entry.engine === "v2") {
            const { result, line } = await runV2(entry, store, startTime, gate);
            results.push(result);
            costLines.push(line);
            continue;
        }

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
            const staleResult = staleFromLkg(entry, result.status === "unavailable" ? result.explanation : (result as StaleResult).reason || "Unknown failure");

            if (staleResult) {
                // RECOVERY: Downgrade to Stale
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
        costLines.push({ game: entry.id, type: entry.type, engine: "v1", status: result.status });
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

    // GitHub Actions visibility: annotate every non-fresh provider in the run UI.
    // Reporting only; the exit policy below is unchanged.
    if (process.env.GITHUB_ACTIONS === "true") {
        for (const r of results) {
            const id = `${r.game}.${r.type}`;
            if (r.status === "stale") {
                console.log(`::warning title=Provider stale::${escapeAnnotation(`${r.title} (${id}) is serving LKG data last fetched ${r.last_success_at_utc}. Reason: ${r.reason}`)}`);
            } else if (r.status === "unavailable") {
                console.log(`::warning title=Provider unavailable::${escapeAnnotation(`${r.title} (${id}) has no data. ${r.explanation}`)}`);
            }
        }
    }

    // AI usage and cost report (counts, tokens and estimates only; never prompts, documents or keys).
    // Reporting only: it never changes the exit policy below.
    try {
        const summary = summarizeRun({ gate, startedAt: runStartedAt, finishedAt: new Date(), trackers: costLines, unavailable });
        const markdown = renderRunSummary(summary);
        console.log("\n" + markdown);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
        if (process.env.GITHUB_ACTIONS === "true" && (summary.remaining.costUsd <= 0 || summary.remaining.calls <= 0)) {
            console.log(`::warning title=AI daily budget reached::${escapeAnnotation(`Estimated AI usage today: $${summary.today.estimatedCostUsd.toFixed(4)} of $${summary.limits.dailyCostUsd.toFixed(2)}, ${summary.today.calls} of ${summary.limits.dailyCalls} calls. AI work is deferred until the next UTC day.`)}`);
        }
    } catch (error) {
        console.error(`AI cost summary could not be written: ${error instanceof Error ? error.message : String(error)}`);
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
