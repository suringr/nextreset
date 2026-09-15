/**
 * The AI budget for one refresh run, and its cost summary.
 *
 * The usage ledger lives in the knowledge store (`<knowledge>/usage/ai/`), which
 * CI checks out from and persists to the knowledge branch, so the daily limits
 * hold across the day's separate runs. When CI runs without that checkout the
 * day's usage cannot be known and nothing would be persisted, so the gate
 * refuses every model call for the run (the work is deferred, never guessed).
 */
import * as fs from "fs";
import * as path from "path";
import { WorkStats } from "../adapter";
import { createAiProvider, readAiConfig } from "../ai/provider";
import { AiBudgetLimits, AiGate, DEFAULT_AI_BUDGET_LIMITS, createAiGate, currentRunId, readAiBudgetLimits } from "./budget";
import { AiCallRecord, AiUsageLedger, LedgerTotals, emptyTotals, utcDate } from "./ledger";
import { formatUsd } from "./pricing";

export function usageLedgerDir(knowledgeRoot: string): string {
    return path.join(knowledgeRoot, "usage", "ai");
}

export interface RunAiGateOptions {
    knowledgeRoot: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
}

export function createRunAiGate(options: RunAiGateOptions): { gate: AiGate; unavailable?: string } {
    const env = options.env ?? process.env;
    let limits: AiBudgetLimits = { ...DEFAULT_AI_BUDGET_LIMITS };
    let unavailable: string | undefined;
    try {
        limits = readAiBudgetLimits(env);
    } catch (error) {
        unavailable = `invalid AI budget configuration (${error instanceof Error ? error.message : String(error)})`;
    }
    if (!unavailable && env.GITHUB_ACTIONS === "true" && !fs.existsSync(path.join(options.knowledgeRoot, ".git"))) {
        unavailable = "the knowledge branch is not checked out, so today's AI usage cannot be tracked across runs and extracted knowledge would not be kept";
    }
    const gate = createAiGate({
        ledger: AiUsageLedger.inDirectory(usageLedgerDir(options.knowledgeRoot)),
        limits,
        runId: currentRunId(env, options.now),
        unavailable,
        env,
        loadProvider: async () => {
            const config = readAiConfig(env);
            return config ? createAiProvider(config) : undefined;
        }
    });
    return { gate, ...(unavailable ? { unavailable } : {}) };
}

/** What one tracker did this run, as the orchestrator saw it. */
export interface TrackerCostLine {
    game: string;
    type: string;
    engine: "v1" | "v2";
    status: string;
    work?: WorkStats;
    /** Set when the tracker's AI work was deferred by the budget. */
    deferred?: string;
    /** Discovery decision, when the tracker considered discovery. */
    discovery?: string;
}

export interface RunCostSummary {
    runId: string;
    date: string;
    limits: AiBudgetLimits;
    unavailable?: string;
    run: LedgerTotals;
    today: LedgerTotals;
    remaining: { calls: number; costUsd: number };
    documents: WorkStats;
    trackers: Array<TrackerCostLine & { ai: LedgerTotals }>;
    calls: AiCallRecord[];
}

function add(totals: LedgerTotals, r: AiCallRecord): void {
    totals.calls++;
    if (!r.success) totals.failures++;
    if (r.repair) totals.repairs++;
    totals.retries += r.retries;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.thoughtTokens += r.thoughtTokens;
    totals.estimatedCostUsd += r.estimatedCostUsd;
}

export function summarizeRun(input: { gate: AiGate; startedAt: Date; finishedAt: Date; trackers: TrackerCostLine[]; unavailable?: string }): RunCostSummary {
    const { gate } = input;
    const date = utcDate(input.finishedAt);
    const dates = [...new Set([utcDate(input.startedAt), date])];
    const calls = dates.flatMap(d => [...gate.ledger.calls(d)]).filter(r => r.runId === gate.runId);
    const run = emptyTotals();
    for (const r of calls) add(run, r);
    const today = gate.ledger.totals(date);
    const documents: WorkStats = { unchanged: 0, deterministic: 0, sentToAi: 0, deferred: 0 };
    for (const t of input.trackers) {
        if (!t.work) continue;
        documents.unchanged += t.work.unchanged;
        documents.deterministic += t.work.deterministic;
        documents.sentToAi += t.work.sentToAi;
        documents.deferred += t.work.deferred;
    }
    const trackers = input.trackers.map(t => {
        const ai = emptyTotals();
        for (const r of calls) if (r.game === t.game && r.topic === t.type) add(ai, r);
        return { ...t, ai };
    });
    return {
        runId: gate.runId,
        date,
        limits: gate.limits,
        ...(input.unavailable ? { unavailable: input.unavailable } : {}),
        run,
        today,
        remaining: {
            calls: Math.max(0, gate.limits.dailyCalls - today.calls),
            costUsd: Math.max(0, gate.limits.dailyCostUsd - today.estimatedCostUsd)
        },
        documents,
        trackers,
        calls
    };
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** Markdown for the GitHub Actions step summary and the log. Counts, tokens and estimates only. */
export function renderRunSummary(s: RunCostSummary): string {
    const lines: string[] = [];
    lines.push("## AI usage and cost guardrails", "");
    lines.push("Costs are estimates from the list prices in `scripts/v2/cost/pricing.ts`, not billing data.", "");
    if (s.unavailable) lines.push(`> **No AI calls allowed this run:** ${cell(s.unavailable)}`, "");
    lines.push(`| | This run | Today (UTC ${s.date}) | Daily limit | Remaining today |`);
    lines.push("|---|---:|---:|---:|---:|");
    lines.push(`| AI calls | ${s.run.calls} | ${s.today.calls} | ${s.limits.dailyCalls} | ${s.remaining.calls} |`);
    lines.push(`| Estimated cost | ${formatUsd(s.run.estimatedCostUsd)} | ${formatUsd(s.today.estimatedCostUsd)} | $${s.limits.dailyCostUsd.toFixed(2)} | ${formatUsd(s.remaining.costUsd)} |`);
    lines.push(`| Input tokens | ${s.run.inputTokens} | ${s.today.inputTokens} | | |`);
    lines.push(`| Output tokens (incl. thinking) | ${s.run.outputTokens + s.run.thoughtTokens} | ${s.today.outputTokens + s.today.thoughtTokens} | | |`);
    lines.push(`| Repair calls | ${s.run.repairs} | ${s.today.repairs} | | |`);
    lines.push(`| Retries inside calls | ${s.run.retries} | ${s.today.retries} | | |`);
    lines.push(`| Failed calls | ${s.run.failures} | ${s.today.failures} | | |`, "");
    lines.push(`Per-topic limit: ${s.limits.perTopicCalls} calls per UTC day.`, "");
    const d = s.documents;
    lines.push(`Documents this run: ${d.unchanged} skipped unchanged, ${d.deterministic} handled deterministically, ${d.sentToAi} sent to AI, ${d.deferred} deferred by the budget.`, "");

    const v2 = s.trackers.filter(t => t.engine === "v2");
    if (v2.length > 0) {
        lines.push("### V2 trackers", "");
        lines.push("| Tracker | Status | Unchanged | Deterministic | Sent to AI | Deferred | AI calls | Est. cost | Notes |");
        lines.push("|---|---|---:|---:|---:|---:|---:|---:|---|");
        for (const t of v2) {
            const w = t.work ?? { unchanged: 0, deterministic: 0, sentToAi: 0, deferred: 0 };
            const notes = [t.deferred ? `deferred_due_to_budget: ${t.deferred}` : "", t.discovery ? `discovery: ${t.discovery}` : ""].filter(Boolean).join("; ");
            lines.push(`| ${t.game}/${t.type} | ${t.status} | ${w.unchanged} | ${w.deterministic} | ${w.sentToAi} | ${w.deferred} | ${t.ai.calls} | ${formatUsd(t.ai.estimatedCostUsd)} | ${cell(notes)} |`);
        }
        lines.push("");
    }

    if (s.calls.length > 0) {
        lines.push("### AI calls this run", "");
        lines.push("| Tracker | Operation | Provider / model | Input | Output | Est. input | Est. output | Est. total | Result |");
        lines.push("|---|---|---|---:|---:|---:|---:|---:|---|");
        for (const c of s.calls) {
            const result = `${c.success ? "ok" : `failed${c.error ? `: ${c.error}` : ""}`}${c.repair ? ", repair" : ""}${c.retries > 0 ? `, ${c.retries} ${c.retries === 1 ? "retry" : "retries"}` : ""}`;
            lines.push(`| ${c.game}/${c.topic} | ${c.operation} | ${c.provider} / ${c.model} | ${c.inputTokens} | ${c.outputTokens + c.thoughtTokens} | ${formatUsd(c.estimatedInputCostUsd)} | ${formatUsd(c.estimatedOutputCostUsd)} | ${formatUsd(c.estimatedCostUsd)} | ${cell(result)} |`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
