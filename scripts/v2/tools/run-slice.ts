/**
 * Runs one V2 topic end to end against the live network and prints everything
 * the evaluation needs: the published view, the adapter report (known sources,
 * discovery queries and candidates, the winning page, confidence reasons, AI
 * usage) and a summary of the stored knowledge (events, claims, documents,
 * learned sources, change history).
 *
 *   node build/v2/tools/run-slice.js lol next-patch [--knowledge <dir>] [--no-config-url] [--out <file>] [--now <iso>]
 *
 * Knowledge goes to build/slice/knowledge by default (never the production
 * store). --no-config-url removes the topic's configured page to exercise
 * discovery. Needs GEMINI_API_KEY for extraction; without it the run fails
 * cleanly, which is also worth seeing.
 */
import * as fs from "fs";
import * as path from "path";
import { createAiProvider, readAiConfig } from "../ai/provider";
import { createAiGate, currentRunId, readAiBudgetLimits } from "../cost/budget";
import { AiUsageLedger, utcDate } from "../cost/ledger";
import { usageLedgerDir } from "../cost/run";
import { readSearchConfig } from "../discovery/search-provider";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { JsonKnowledgeStore } from "../store";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const [gameId, type] = process.argv.slice(2).filter(a => !a.startsWith("--") && a !== arg("--knowledge") && a !== arg("--out") && a !== arg("--now"));
    if (!gameId || !type) {
        console.error("usage: run-slice <game> <type> [--knowledge <dir>] [--no-config-url] [--out <file>] [--now <iso>]");
        process.exit(2);
    }
    const knowledgeDir = path.resolve(arg("--knowledge") ?? path.join(process.cwd(), "build", "slice", "knowledge"));
    const outFile = path.resolve(arg("--out") ?? path.join(process.cwd(), "build", "slice", `${gameId}-${type}.json`));
    const now = arg("--now") ? new Date(arg("--now")!) : new Date();
    const dropConfigured = process.argv.includes("--no-config-url");

    const base = findGame(gameId);
    const game = dropConfigured ? { ...base, sources: [] } : base;
    const topic = findTopic(game, type);
    const store = new JsonKnowledgeStore(knowledgeDir);
    const ai = readAiConfig();
    const search = readSearchConfig();
    console.log(`Slice ${gameId}/${type} at ${now.toISOString()}`);
    console.log(`  knowledge: ${store.describe(gameId)}`);
    console.log(`  configured page: ${dropConfigured ? "(removed for this run)" : game.sources.find(s => s.id === topic.sourceId)?.url ?? "(none)"}`);
    console.log(`  AI: ${ai ? `${ai.provider} ${ai.model}` : "not configured (GEMINI_API_KEY missing)"}; web search: ${search.provider}`);

    // The production budget rules apply, with a ledger next to the throwaway knowledge (one run id per slice run).
    const gate = createAiGate({
        ledger: AiUsageLedger.inDirectory(usageLedgerDir(knowledgeDir)),
        limits: readAiBudgetLimits(),
        runId: `${currentRunId(process.env, now)}-${path.basename(outFile, ".json")}`,
        // A simulated --now keeps budget days on the simulated time; a real run follows the wall clock.
        ...(arg("--now") ? {} : { clock: () => new Date() }),
        loadProvider: async () => (ai ? createAiProvider(ai) : undefined)
    });

    const started = Date.now();
    const run = await runTracker(game, topic, adapterFor(topic), store, now, { ai: gate });
    const aiCalls = gate.callsMade();
    const elapsedMs = Date.now() - started;
    const knowledge = run.knowledge;
    const summary = {
        ranAt: now.toISOString(),
        elapsedMs,
        configuredPageRemoved: dropConfigured,
        view: run.result,
        report: run.report,
        changesThisRun: run.changes,
        created: run.created,
        saveError: run.saveError,
        work: run.work,
        deferred: run.deferred,
        aiCalls,
        aiBudget: { limits: gate.limits, today: gate.ledger.totals(utcDate(now)) },
        knowledge: knowledge ? {
            file: store.describe(gameId),
            events: knowledge.events,
            claims: knowledge.claims,
            documents: knowledge.documents,
            discovered: knowledge.discovered,
            sources: knowledge.sources,
            changes: knowledge.changes
        } : null
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n", "utf8");

    console.log(`\nView (${run.result.status}):`);
    console.log(JSON.stringify(run.result, null, 2));
    const report = run.report as any;
    if (report) {
        console.log("\nKnown sources:", JSON.stringify(report.knownSources));
        for (const a of report.attempts ?? []) console.log(`  attempt [${a.via}] ${a.url} -> ${a.outcome}${a.reason ? ` (${a.reason})` : ""}${a.fetch ? ` [${a.fetch.mode} ${a.fetch.status} ${a.fetch.verdict ?? ""}]` : ""}${a.extraction ? ` items=${a.extraction.items} accepted=${a.extraction.accepted} rejected=${a.extraction.rejected}` : ""}`);
        if (report.decision) console.log("Discovery decision:", JSON.stringify(report.decision));
        if (report.discovery) {
            for (const q of report.discovery.queries) console.log(`  query [${q.provider}] ${q.query} -> ${q.results}${q.error ? ` (${q.error})` : ""} in ${q.elapsedMs} ms`);
            for (const c of report.discovery.candidates) console.log(`  candidate ${String(c.score).padStart(2)} ${c.tier} ${c.via} ${c.url}`);
            for (const r of report.discovery.rejected) console.log(`  rejected ${r.url} (${r.reason})`);
            console.log(`  searchedWeb=${report.discovery.searchedWeb} unavailable=${JSON.stringify(report.discovery.unavailable)}`);
        }
        if (report.winner) console.log("Winner:", JSON.stringify(report.winner));
        if (report.confidence) console.log("Confidence:", report.confidence.level, "\n  - " + report.confidence.reasons.join("\n  - "));
        console.log("AI usage:", JSON.stringify(report.ai));
    }
    console.log("Work:", JSON.stringify(run.work ?? {}), run.deferred ? `deferred_due_to_budget: ${run.deferred.detail}` : "");
    for (const c of aiCalls) console.log(`  AI call ${c.operation} ${c.model}: ${c.inputTokens} in / ${c.outputTokens + c.thoughtTokens} out, est. $${c.estimatedCostUsd.toFixed(4)}${c.success ? "" : ` (failed: ${c.error ?? "unknown"})`}`);
    if (knowledge) {
        console.log(`\nKnowledge: ${knowledge.events.length} event(s), ${knowledge.claims.length} claim(s), ${knowledge.documents.length} document(s), ${knowledge.discovered.length} learned source(s), ${knowledge.changes.length} change(s)`);
        for (const e of knowledge.events) console.log(`  event ${e.key} ${e.status} ${e.at ?? e.startAt} (${e.precision})`);
        for (const c of knowledge.claims) console.log(`  claim ${c.eventKey} ${c.field}=${c.value} "${c.quote}"`);
        for (const d of knowledge.discovered) console.log(`  learned ${d.url} via ${d.via} successes=${d.successes} failures=${d.failures}`);
    }
    console.log(`\nWritten to ${outFile} (${elapsedMs} ms)`);
}

main().catch(error => {
    console.error("slice failed:", error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
