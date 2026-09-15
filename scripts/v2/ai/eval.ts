/**
 * Gold evaluation for AI extraction.
 *
 * Runs classification + extraction + grounding over the gold documents in
 * scripts/v2/__tests__/gold and compares the accepted facts with the expected
 * ones. Two modes:
 *   - mock (default): scripted responses from gold/mock-responses.json (offline, used by tests)
 *   - live (--live):  the configured provider (needs GEMINI_API_KEY), run in CI on demand
 *
 * Writes build/ai-eval/report.{json,md}; exits 1 if any case fails.
 * Never prints prompts, keys or full documents.
 */
import * as fs from "fs";
import * as path from "path";
import { normalizeIdentity } from "../identity";
import { AiDocument, DocType, ExtractionTopic, GroundedItem, classifyDocument, extractFacts, tokensOf } from "./extraction";
import { MockAiProvider, scriptedResponder } from "./mock";
import { AiProvider, AiUsageTracker, TrackedAiProvider, createAiProvider, readAiConfig } from "./provider";

export interface GoldExpectation {
    /** Any of these may satisfy the expectation, matched against the normalized identity or label. */
    identityAnyOf: string[];
    field?: "at" | "startAt" | "endAt";
    /** YYYY-MM-DD of the reported value (local to the stated zone). */
    date?: string;
    /** The normalized UTC instant; required for exact-precision expectations. */
    at?: string;
    status?: string[];
    precision?: "exact" | "day";
    yearInferred?: boolean;
}

export interface GoldCase {
    id: string;
    game: string;
    gameName: string;
    topicType: string;
    topicDescription: string;
    doc: string;
    url: string;
    title?: string;
    now: string;
    classification?: { relevant?: boolean; docTypeAnyOf?: DocType[] };
    expect: GoldExpectation[];
    /** No accepted date fact may exist (the document states no dates). */
    noDates?: boolean;
    /** No accepted item's identity may match this (case-insensitive substring). */
    noItemsMatching?: string;
}

export interface CaseReport {
    id: string;
    passed: boolean;
    failures: string[];
    classification?: { relevant: boolean; docType: string; summary: string };
    items: Array<{ identity: string; kind: string; status: string; facts: Array<{ field: string; value: string; at: string; precision: string; timezone?: string; yearInferred: boolean }> }>;
    rejected: Array<{ identity: string; field: string; value: string; quote: string; reason: string }>;
    grounding: { fields: number; accepted: number; rejected: number };
    error?: string;
}

export interface EvalReport {
    mode: "mock" | "live";
    provider: string;
    model: string;
    ranAt: string;
    cases: CaseReport[];
    summary: {
        cases: number;
        passed: number;
        failed: number;
        expectations: number;
        expectationsMet: number;
        fieldsSeen: number;
        fieldsAccepted: number;
        fieldsRejected: number;
        calls: number;
        failures: number;
        inputTokens: number;
        outputTokens: number;
        thoughtTokens: number;
        estimatedCostUsd?: number;
    };
}

export const GOLD_DIR = path.resolve(__dirname, "..", "..", "..", "scripts", "v2", "__tests__", "gold");

export function loadGoldCases(dir = GOLD_DIR): GoldCase[] {
    return JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8")) as GoldCase[];
}

/**
 * An alias matches when it equals the normalized identity, or when every one of
 * its tokens occurs as a whole token in the identity or the label ("6.19" does
 * not match "26.19"; "update 43.1" matches "Update 43.1: Sunlit Skies").
 */
export function matchesIdentity(item: GroundedItem, anyOf: string[]): boolean {
    const identityTokens = new Set(tokensOf(item.identity));
    const labelTokens = new Set(tokensOf(item.label));
    return anyOf.some(candidate => {
        let key: string | undefined;
        try { key = normalizeIdentity(candidate); } catch { key = undefined; }
        if (key !== undefined && item.identityKey === key) return true;
        const needed = tokensOf(candidate);
        return needed.length > 0 && (needed.every(t => identityTokens.has(t)) || needed.every(t => labelTokens.has(t)));
    });
}

/** A gold case cannot ask for an exact instant without saying which one. */
export function validateGoldCases(cases: GoldCase[]): void {
    for (const c of cases) {
        for (const e of c.expect) {
            if (e.precision === "exact" && !e.at) throw new Error(`gold case ${c.id}: expectation ${e.identityAnyOf[0]} requires precision exact but gives no \`at\``);
        }
    }
}

function evaluateCase(gold: GoldCase, classification: CaseReport["classification"], items: GroundedItem[]): string[] {
    const failures: string[] = [];

    if (gold.classification) {
        if (gold.classification.relevant !== undefined && classification && classification.relevant !== gold.classification.relevant) {
            failures.push(`classification.relevant expected ${gold.classification.relevant}, got ${classification.relevant}`);
        }
        if (gold.classification.docTypeAnyOf && classification && !gold.classification.docTypeAnyOf.includes(classification.docType as DocType)) {
            failures.push(`classification.docType expected one of ${gold.classification.docTypeAnyOf.join("|")}, got ${classification.docType}`);
        }
    }

    for (const exp of gold.expect) {
        const candidates = items.filter(i => matchesIdentity(i, exp.identityAnyOf));
        if (candidates.length === 0) {
            failures.push(`no item with identity ${exp.identityAnyOf.join("|")}`);
            continue;
        }
        if (exp.date) {
            const hit = candidates.find(i => i.facts.some(f =>
                (!exp.field || f.field === exp.field) &&
                f.value.slice(0, 10) === exp.date &&
                (!exp.at || f.at === exp.at) &&
                (!exp.precision || f.precision === exp.precision) &&
                (exp.yearInferred === undefined || f.yearInferred === exp.yearInferred)
            ));
            if (!hit) {
                const seen = candidates.flatMap(i => i.facts.map(f => `${f.field}=${f.value} → ${f.at} (${f.precision})`)).join(", ") || "no accepted facts";
                failures.push(`item ${exp.identityAnyOf[0]}: expected ${exp.field ?? "any field"} on ${exp.date}${exp.at ? ` = ${exp.at}` : ""}${exp.precision ? ` (${exp.precision})` : ""}; accepted: ${seen}`);
                continue;
            }
            if (exp.status && !exp.status.includes(hit.status)) {
                failures.push(`item ${exp.identityAnyOf[0]}: expected status ${exp.status.join("|")}, got ${hit.status}`);
            }
        } else if (exp.status && !candidates.some(i => exp.status!.includes(i.status))) {
            failures.push(`item ${exp.identityAnyOf[0]}: expected status ${exp.status.join("|")}, got ${candidates.map(i => i.status).join(",")}`);
        }
    }

    if (gold.noDates) {
        const dated = items.filter(i => i.facts.length > 0);
        if (dated.length > 0) failures.push(`expected no accepted dates, got ${dated.map(i => `${i.identity}: ${i.facts.map(f => f.value).join(",")}`).join("; ")}`);
    }
    if (gold.noItemsMatching) {
        const needle = gold.noItemsMatching.toLowerCase();
        const bad = items.filter(i => i.identity.toLowerCase().includes(needle) || i.label.toLowerCase().includes(needle));
        if (bad.length > 0) failures.push(`items matching "${gold.noItemsMatching}" must not appear: ${bad.map(i => i.identity).join(", ")}`);
    }
    return failures;
}

export interface RunGoldEvalOptions {
    provider: AiProvider;
    mode: "mock" | "live";
    cases?: GoldCase[];
    goldDir?: string;
    /** USD per 1M tokens, when known; the report includes an estimate. */
    pricePerMInput?: number;
    pricePerMOutput?: number;
}

export async function runGoldEval(options: RunGoldEvalOptions): Promise<EvalReport> {
    const goldDir = options.goldDir ?? GOLD_DIR;
    const cases = options.cases ?? loadGoldCases(goldDir);
    validateGoldCases(cases);
    const tracker = new AiUsageTracker();
    const provider = new TrackedAiProvider(options.provider, tracker);
    const reports: CaseReport[] = [];
    let expectations = 0;
    let expectationsMet = 0;

    for (const gold of cases) {
        const topic: ExtractionTopic = { game: gold.game, gameName: gold.gameName, type: gold.topicType, description: gold.topicDescription };
        const doc: AiDocument = { url: gold.url, title: gold.title, text: fs.readFileSync(path.join(goldDir, gold.doc), "utf8") };
        const now = new Date(gold.now);
        const report: CaseReport = { id: gold.id, passed: false, failures: [], items: [], rejected: [], grounding: { fields: 0, accepted: 0, rejected: 0 } };
        try {
            const { classification } = await classifyDocument(provider, topic, doc, { now });
            report.classification = { relevant: classification.relevant, docType: classification.docType, summary: classification.summary };
            const extraction = await extractFacts(provider, topic, doc, { now });
            report.items = extraction.grounded.items.map(i => ({
                identity: i.identity, kind: i.kind, status: i.status,
                facts: i.facts.map(f => ({ field: f.field, value: f.value, at: f.at, precision: f.precision, timezone: f.timezone, yearInferred: f.yearInferred }))
            }));
            report.rejected = extraction.grounded.rejected.map(r => ({ identity: r.identity, field: r.field, value: r.value, quote: r.quote.length > 160 ? `${r.quote.slice(0, 160)}…` : r.quote, reason: r.reason }));
            report.grounding = { fields: extraction.grounded.stats.fields, accepted: extraction.grounded.stats.accepted, rejected: extraction.grounded.stats.rejected };
            report.failures = evaluateCase(gold, report.classification, extraction.grounded.items);
        } catch (error) {
            report.error = error instanceof Error ? error.message : String(error);
            report.failures.push(`error: ${report.error}`);
        }
        const expCount = gold.expect.length + (gold.classification ? 1 : 0) + (gold.noDates ? 1 : 0) + (gold.noItemsMatching ? 1 : 0);
        expectations += expCount;
        // A case that errored before evaluation met none of its expectations.
        expectationsMet += report.error ? 0 : Math.max(0, expCount - report.failures.length);
        report.passed = report.failures.length === 0;
        reports.push(report);
    }

    const usage = tracker.summary();
    const estimatedCostUsd = options.pricePerMInput !== undefined && options.pricePerMOutput !== undefined
        ? (usage.inputTokens / 1e6) * options.pricePerMInput + ((usage.outputTokens + usage.thoughtTokens) / 1e6) * options.pricePerMOutput
        : undefined;

    return {
        mode: options.mode,
        provider: options.provider.name,
        model: options.provider.model,
        ranAt: new Date().toISOString(),
        cases: reports,
        summary: {
            cases: reports.length,
            passed: reports.filter(r => r.passed).length,
            failed: reports.filter(r => !r.passed).length,
            expectations,
            expectationsMet,
            fieldsSeen: reports.reduce((n, r) => n + r.grounding.fields, 0),
            fieldsAccepted: reports.reduce((n, r) => n + r.grounding.accepted, 0),
            fieldsRejected: reports.reduce((n, r) => n + r.grounding.rejected, 0),
            calls: usage.calls,
            failures: usage.failures,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            thoughtTokens: usage.thoughtTokens,
            estimatedCostUsd
        }
    };
}

export function renderMarkdown(report: EvalReport): string {
    const s = report.summary;
    const lines: string[] = [];
    lines.push(`# AI extraction gold evaluation (${report.mode})`, "");
    lines.push(`Provider: ${report.provider} · Model: ${report.model} · Ran: ${report.ranAt}`, "");
    lines.push(`| cases | passed | failed | expectations met | fields seen | accepted | rejected | calls | failures | input tokens | output tokens | thought tokens | est. cost |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
    lines.push(`| ${s.cases} | ${s.passed} | ${s.failed} | ${s.expectationsMet}/${s.expectations} | ${s.fieldsSeen} | ${s.fieldsAccepted} | ${s.fieldsRejected} | ${s.calls} | ${s.failures} | ${s.inputTokens} | ${s.outputTokens} | ${s.thoughtTokens} | ${s.estimatedCostUsd !== undefined ? `$${s.estimatedCostUsd.toFixed(4)}` : "n/a"} |`, "");
    for (const c of report.cases) {
        lines.push(`## ${c.passed ? "✅" : "❌"} ${c.id}`);
        if (c.classification) lines.push(`- classification: relevant=${c.classification.relevant}, docType=${c.classification.docType} — ${c.classification.summary}`);
        for (const i of c.items) {
            const facts = i.facts.map(f => `${f.field}=${f.value}${f.timezone ? ` ${f.timezone}` : ""} → ${f.at} (${f.precision}${f.yearInferred ? ", year inferred" : ""})`).join("; ");
            lines.push(`- ${i.kind} **${i.identity}** [${i.status}] ${facts || "(no dated facts)"}`);
        }
        for (const r of c.rejected) lines.push(`- rejected: ${r.identity} ${r.field}=${r.value}: ${r.reason}${r.quote ? ` — quote: "${r.quote}"` : ""}`);
        for (const f of c.failures) lines.push(`- **FAIL**: ${f}`);
        lines.push("");
    }
    return lines.join("\n");
}

export function loadMockScript(dir = GOLD_DIR): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(dir, "mock-responses.json"), "utf8")) as Record<string, unknown>;
}

/**
 * A mock provider keyed per gold case. classify/extract only know the generic
 * labels ("classify", "extract"), so the case is recognised from the prompt's
 * topic block and document title, which are unique per gold case, and the
 * scripted response is looked up as "<caseId>:<label>".
 */
export function mockGoldProvider(script: Record<string, unknown>, cases: GoldCase[]): MockAiProvider {
    const respond = scriptedResponder(script);
    return new MockAiProvider("mock-gold", (request) => {
        const match = cases.find(c =>
            request.prompt.includes(`Game: ${c.gameName} (${c.game})\nTopic: ${c.topicType}\n`) &&
            request.prompt.includes(`Document title: ${c.title ?? ""}\n`));
        if (!match) throw new Error(`mock gold provider: no case matches the prompt (label ${request.label})`);
        return respond({ ...request, label: `${match.id}:${request.label}` });
    });
}

async function main(): Promise<void> {
    const live = process.argv.includes("--live");
    const outDir = path.resolve(process.cwd(), "build", "ai-eval");
    const cases = loadGoldCases();
    let provider: AiProvider;
    if (live) {
        const config = readAiConfig();
        if (!config) {
            console.error("Live evaluation needs GEMINI_API_KEY (and optionally AI_MODEL).");
            process.exit(2);
        }
        provider = await createAiProvider(config);
        console.log(`Live evaluation with ${provider.name} / ${provider.model}`);
    } else {
        provider = mockGoldProvider(loadMockScript(), cases);
    }

    const price = (name: string) => process.env[name] ? Number(process.env[name]) : undefined;
    const report = await runGoldEval({
        provider, cases, mode: live ? "live" : "mock",
        pricePerMInput: price("AI_PRICE_INPUT_PER_M"), pricePerMOutput: price("AI_PRICE_OUTPUT_PER_M")
    });

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    const md = renderMarkdown(report);
    fs.writeFileSync(path.join(outDir, "report.md"), md);
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    process.exit(report.summary.failed === 0 ? 0 : 1);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
