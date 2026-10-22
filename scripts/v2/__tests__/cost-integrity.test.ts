/**
 * Calls that are billed must be counted, and counted once, wherever they are made.
 *
 * Three gaps let spend escape the daily budget before this:
 *
 * - The refresh workflow put pull-request checks and production publishes in one concurrency group with
 *   cancel-in-progress, so a push to any pull request could cancel a publish after its model calls and
 *   before the step that pushes the usage ledger. And that step was skipped whenever the build failed.
 * - A refresh on a developer machine wrote a ledger of its own: a second daily budget production never saw.
 * - The live gold evaluation called the model through no gate at all.
 *
 * The workflow is read as text, the way workflows.test.ts reads it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { documentCallPlan } from "../adapters/ai-discovery";
import { loadGoldCases, loadMockScript, mockGoldProvider, runGoldEval } from "../ai/eval";
import { AiBudgetExceededError, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { createRunAiGate, localAiRefusal } from "../cost/run";

const NOW = new Date("2026-10-22T12:00:00Z");
// The mock provider's model has no list price; the gate refuses unpriced models, so the test prices it.
const PRICED = { AI_PRICE_INPUT_PER_M: "1.5", AI_PRICE_OUTPUT_PER_M: "9" };
const WORKFLOW = fs.readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "refresh-data.yml"), "utf8").replace(/\r\n/g, "\n");

function jobBlock(job: string): string {
    const lines = WORKFLOW.split("\n");
    const start = lines.findIndex(l => l === `  ${job}:`);
    assert.notEqual(start, -1, `no job ${job}`);
    const end = lines.findIndex((l, i) => i > start && /^  [a-z][\w-]*:\s*$/.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** The block of one step, by its name, up to the next step. */
function stepBlock(job: string, name: string): string {
    const lines = jobBlock(job).split("\n");
    const start = lines.findIndex(l => l.trim() === `- name: ${name}`);
    assert.notEqual(start, -1, `no step ${name}`);
    const end = lines.findIndex((l, i) => i > start && /^\s*- (name|uses|run):/.test(l) && l.indexOf("-") <= lines[start].indexOf("-"));
    return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("a production publish is never cancelled, and is the only writer at a time", () => {
    assert.doesNotMatch(WORKFLOW, /^concurrency:/m, "no workflow-level group: it would put pull-request checks in the publish queue");
    const publish = jobBlock("publish");
    assert.match(publish, /\n    concurrency:\n      group: publish-dist\n      cancel-in-progress: false\n/);
});

test("pull-request checks queue apart from publishes and may supersede each other", () => {
    const check = jobBlock("pr-check");
    assert.match(check, /\n    concurrency:\n      group: pr-check-\$\{\{ github\.ref \}\}\n      cancel-in-progress: true\n/);
    assert.doesNotMatch(check, /publish-dist/);
});

test("the knowledge branch, and the usage ledger in it, is persisted even when the build failed or was cancelled", () => {
    const persist = stepBlock("publish", "Persist knowledge branch");
    assert.match(persist, /\n\s+if: always\(\)\n/, "calls already billed must reach the ledger");
    assert.match(persist, /continue-on-error: true/);
    // It must run before the publish step wipes the working tree.
    const publish = jobBlock("publish");
    assert.ok(publish.indexOf("- name: Persist knowledge branch") < publish.indexOf("- name: Publish dist/ to gh-pages"));
});

test("outside CI the model is refused unless someone opts in", () => {
    assert.match(localAiRefusal({})!, /AI_ALLOW_LOCAL=1/);
    assert.match(localAiRefusal({ GEMINI_API_KEY: "k" })!, /production workflow/);
    assert.equal(localAiRefusal({ GITHUB_ACTIONS: "true" }), undefined);
    assert.equal(localAiRefusal({ AI_ALLOW_LOCAL: "1" }), undefined);
    assert.match(localAiRefusal({ AI_ALLOW_LOCAL: "true" })!, /AI_ALLOW_LOCAL=1/, "only the exact value opts in");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-local-"));
    const local = createRunAiGate({ knowledgeRoot: root, env: { GEMINI_API_KEY: "k-123456789" } });
    assert.match(local.unavailable ?? "", /AI_ALLOW_LOCAL=1/);
    const verdict = local.gate.check("lol", "next-patch", NOW, documentCallPlan(1000));
    assert.equal(!verdict.ok && verdict.reason, "budget-unavailable");
    assert.equal(createRunAiGate({ knowledgeRoot: root, env: { AI_ALLOW_LOCAL: "1" } }).unavailable, undefined);
    // An invalid configuration still reports itself first: it is the more specific problem.
    assert.match(createRunAiGate({ knowledgeRoot: root, env: { AI_DAILY_CALL_LIMIT: "lots" } }).unavailable ?? "", /invalid AI budget configuration/);
});

test("a live gold evaluation is held to the same ceilings, each case as its own topic", async () => {
    const cases = loadGoldCases();
    const provider = mockGoldProvider(loadMockScript(), cases);
    const ledger = AiUsageLedger.inMemory();
    const budget = createAiGate({ ledger, limits: { dailyCostUsd: 2, dailyCalls: 3, perTopicCalls: 5 }, runId: "eval-test", env: PRICED, loadProvider: async () => provider });
    const report = await runGoldEval({ provider, cases, mode: "mock", budget });

    assert.equal(provider.requests.length, 3, "no call past the run's call ceiling");
    assert.equal(budget.callsMade().length, 3, "every call made is recorded");
    assert.ok(budget.callsMade().every(c => c.game === "eval" && cases.some(g => g.id === c.topic)), "each case is budgeted as its own topic");
    assert.ok(report.summary.failed > 0, "cases refused by the budget fail");
    assert.ok(report.cases.some(c => c.failures.some(f => f.includes(new AiBudgetExceededError("daily-calls", "").message.split(":")[0]))), "and the refusal is named in the report");
});

test("a live gold evaluation's per-case limit is the production per-topic limit", async () => {
    const cases = loadGoldCases();
    const provider = mockGoldProvider(loadMockScript(), cases);
    const budget = createAiGate({ ledger: AiUsageLedger.inMemory(), limits: { dailyCostUsd: 2, dailyCalls: 100, perTopicCalls: 1 }, runId: "eval-test", env: PRICED, loadProvider: async () => provider });
    await runGoldEval({ provider, cases, mode: "mock", budget });
    const perCase = new Map<string, number>();
    for (const c of budget.callsMade()) perCase.set(c.topic, (perCase.get(c.topic) ?? 0) + 1);
    assert.ok([...perCase.values()].every(n => n <= 1), "no case past its own ceiling");
    assert.equal(perCase.size, cases.length, "every case got its own allowance");
});

test("without a budget a mock evaluation runs every case, as before", async () => {
    const cases = loadGoldCases();
    const provider = mockGoldProvider(loadMockScript(), cases);
    const report = await runGoldEval({ provider, cases, mode: "mock" });
    assert.equal(report.summary.failed, 0);
    assert.ok(provider.requests.length > 3);
});
