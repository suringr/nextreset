/**
 * Cost guardrails: the cheapest reliable path runs first, and the AI budget is
 * enforced without trading accuracy for staying under it.
 *
 *   unchanged document      -> same hash -> no model call
 *   structured JSON / rule  -> deterministic -> no model call
 *   changed relevant prose  -> model -> every call recorded with tokens and an estimated cost
 *   budget exhausted        -> no call, last known-good kept, work deferred, page not marked as seen
 *   topic limit exhausted   -> the same safe behavior
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { documentCallPlan, discoveryCallPlan, createAiDiscoveryAdapter } from "../adapters/ai-discovery";
import { gtaWeeklyResetAdapter } from "../adapters/gta";
import { createRobloxStatusAdapter } from "../adapters/roblox";
import { GeminiClientLike, GeminiProvider, GeminiResponseLike } from "../ai/gemini";
import { MockAiProvider } from "../ai/mock";
import { AiError, AiJsonRequest, AiProvider } from "../ai/provider";
import { AiBudgetLimits, AiGate, DEFAULT_AI_BUDGET_LIMITS, createAiGate, readAiBudgetLimits } from "../cost/budget";
import { AiCallRecord, AiUsageLedger } from "../cost/ledger";
import { estimateCost, priceFor } from "../cost/pricing";
import { createRunAiGate, renderRunSummary, summarizeRun, usageLedgerDir } from "../cost/run";
import { discoveryDue } from "../discovery/cadence";
import { MockSearchProvider, SearchProvider } from "../discovery/search-provider";
import { Event, emptyKnowledge } from "../domain";
import { LOL_NEXT_PATCH_SPEC, LOL_PATCH_SCHEDULE_URL, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fakeTransport, fixture } from "./fake-transport";
import robloxFeed from "./fixtures/roblox-hostedstatus.json";
import { tempStore } from "./helpers";
import { RoutedTransport, routedTransport } from "./routed-transport";

const FINAL = "https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends";
const NOW = new Date("2026-09-15T06:00:00Z");
const TODAY = "2026-09-15";
const SPEC = { description: LOL_NEXT_PATCH_SPEC.description, docTypes: [...LOL_NEXT_PATCH_SPEC.docTypes], itemKinds: [...LOL_NEXT_PATCH_SPEC.itemKinds] };
const GAME = findGame("lol");
const TOPIC = findTopic(GAME, "next-patch");

const SCHEDULE_ITEMS = {
    items: [
        { kind: "version", label: "26.18", identity: "26.18", status: "released", fields: [{ field: "at", value: "2026-09-10", timezone: "", quote: "26.18 September 10, 2026 (Thursday)" }] },
        { kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "", quote: "26.19 September 23, 2026" }] },
        { kind: "version", label: "26.20", identity: "26.20", status: "scheduled", fields: [{ field: "at", value: "2026-10-07", timezone: "", quote: "26.20 October 7, 2026" }] }
    ]
};
/** The same answer with 26.19 paraphrased: its quote cannot be verified, so extraction asks for one repair. */
const PARAPHRASED_ITEMS = {
    items: [SCHEDULE_ITEMS.items[0], { ...SCHEDULE_ITEMS.items[1], fields: [{ field: "at", value: "2026-09-23", timezone: "", quote: "patch 26.19 arrives on the 23rd of September 2026" }] }, SCHEDULE_ITEMS.items[2]]
};
const CLASSIFIED = { relevant: true, docType: "patch-schedule", summary: "Riot's planned 2026 patch schedule." };

const ORIGINAL = fixture("riot-support-patch-schedule-rendered.html");
/** The same schedule with one more sentence: a different text hash, the same facts. */
const CHANGED = ORIGINAL.replace("</main>", "<p>Schedule note: patch dates can move around holidays and major esports events.</p></main>");

function lolTransport(rendered = ORIGINAL): RoutedTransport {
    const shell = fixture("riot-support-shell.html");
    return routedTransport({
        [LOL_PATCH_SCHEDULE_URL]: { body: shell, finalUrl: FINAL },
        [FINAL]: { body: shell }
    }, {
        [LOL_PATCH_SCHEDULE_URL]: { html: rendered, finalUrl: FINAL },
        [FINAL]: { html: rendered }
    });
}

/** Mock model that bills every call what classify and extract used together on the live League of Legends schedule (a conservative stand-in). */
function scheduleAi(extract: unknown = SCHEDULE_ITEMS, onRequest?: (req: AiJsonRequest) => void): MockAiProvider {
    return new MockAiProvider("gemini-3.5-flash", (req: AiJsonRequest) => {
        onRequest?.(req);
        if (req.label === "classify") return CLASSIFIED;
        if (req.label === "extract") return extract;
        if (req.label === "extract-repair") return SCHEDULE_ITEMS;
        throw new Error(`unexpected label ${req.label}`);
    }, { inputTokens: 2276, outputTokens: 2930 });
}

function gateFor(provider: AiProvider | undefined, options: { ledger?: AiUsageLedger; limits?: Partial<AiBudgetLimits>; runId?: string; unavailable?: string } = {}): AiGate {
    return createAiGate({
        ledger: options.ledger ?? AiUsageLedger.inMemory(),
        limits: { ...DEFAULT_AI_BUDGET_LIMITS, ...options.limits },
        runId: options.runId ?? "test-run",
        model: provider?.model,
        loadProvider: async () => provider,
        env: {},
        ...(options.unavailable ? { unavailable: options.unavailable } : {})
    });
}

/** The adapter under the run's gate; a model obtained any other way fails the test. */
function lolAdapter(transport: RoutedTransport, search: { official: SearchProvider[] } = { official: [] }) {
    return createAiDiscoveryAdapter(SPEC, { transport, search: () => search, ai: async () => { throw new Error("the model must come from the run's budget gate"); } });
}

function spent(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
    return {
        at: NOW.toISOString(), runId: "earlier-run", provider: "gemini", model: "gemini-3.5-flash", game: "lol", topic: "next-patch",
        operation: "extract", repair: false, success: true, retries: 0, inputTokens: 1000, outputTokens: 1000, thoughtTokens: 0,
        estimatedInputCostUsd: 0, estimatedOutputCostUsd: 0, estimatedCostUsd: 0, priceSource: "test", ...overrides
    };
}

const scheduleState = (store: ReturnType<typeof tempStore>["store"]) => store.load("lol").sources.find(s => s.id === "lol-patch-schedule")!;

test("an unchanged document keeps its hash and makes no model call", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const first = await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, NOW, { ai: gateFor(scheduleAi(), { ledger }) });
    assert.equal(first.result.status, "fresh");
    assert.equal(ledger.calls(TODAY).length, 2);
    const hash = scheduleState(store).textHash;

    const ai = scheduleAi();
    const again = await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, new Date("2026-09-15T12:00:00Z"), { ai: gateFor(ai, { ledger }) });
    assert.equal(again.result.status, "fresh");
    assert.equal(ai.requests.length, 0, "no model call");
    assert.equal(ledger.calls(TODAY).length, 2, "nothing recorded");
    assert.deepEqual(again.work, { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 });
    assert.equal((again.report as any).ai.calls, 0);
    assert.equal(scheduleState(store).textHash, hash);
});

test("structured JSON and recurring rules are handled deterministically, with no model call", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const noModel = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("structured data must never reach the model"); });
    const gate = gateFor(noModel, { ledger });

    const roblox = findGame("roblox");
    const status = findTopic(roblox, "status");
    const adapter = createRobloxStatusAdapter(fakeTransport({ http: [{ body: JSON.stringify(robloxFeed), headers: { etag: "\"feed-v1\"" } }] }));
    const parsed = await runTracker(roblox, status, adapter, store, NOW, { ai: gate });
    assert.equal(parsed.result.status, "fresh");
    assert.deepEqual(parsed.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });
    const unchanged = await runTracker(roblox, status, adapter, store, new Date("2026-09-15T12:00:00Z"), { ai: gate });
    assert.equal(unchanged.result.status, "fresh");
    assert.deepEqual(unchanged.work, { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 });

    const gta = findGame("gta");
    const rule = await runTracker(gta, findTopic(gta, "weekly-reset"), gtaWeeklyResetAdapter, store, NOW, { ai: gate });
    assert.equal(rule.result.status, "fresh");
    assert.deepEqual(rule.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });

    assert.equal(noModel.requests.length, 0);
    assert.equal(ledger.calls(TODAY).length, 0);
    assert.deepEqual(store.load("roblox").topicStates, [], "structured topics keep no discovery or AI state");
    assert.deepEqual(store.load("gta").topicStates, []);
});

test("a changed, relevant page goes to the model and every call is recorded with tokens and an estimated cost", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, NOW, { ai: gateFor(scheduleAi(), { ledger, runId: "run-1" }) });

    const ai = scheduleAi();
    const run = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(CHANGED)), store, new Date("2026-09-15T12:00:00Z"), { ai: gateFor(ai, { ledger, runId: "run-2" }) });
    assert.equal(run.result.status, "fresh");
    assert.deepEqual(ai.requests.map(r => r.label), ["classify", "extract"]);
    assert.deepEqual(run.work, { unchanged: 0, deterministic: 0, sentToAi: 1, deferred: 0 });

    const calls = ledger.calls(TODAY).filter(c => c.runId === "run-2");
    assert.deepEqual(calls.map(c => [c.provider, c.model, c.game, c.topic, c.operation, c.repair, c.success, c.retries, c.inputTokens, c.outputTokens]), [
        ["mock", "gemini-3.5-flash", "lol", "next-patch", "classify", false, true, 0, 2276, 2930],
        ["mock", "gemini-3.5-flash", "lol", "next-patch", "extract", false, true, 0, 2276, 2930]
    ]);
    const expected = estimateCost(priceFor("gemini-3.5-flash", {})!, { inputTokens: 2276, outputTokens: 2930 });
    assert.ok(Math.abs(expected.totalUsd - 0.029784) < 1e-9, "classify and extract together cost about three cents on the live schedule");
    for (const c of calls) {
        assert.deepEqual([c.estimatedInputCostUsd, c.estimatedOutputCostUsd, c.estimatedCostUsd], [expected.inputUsd, expected.outputUsd, expected.totalUsd]);
        assert.match(c.priceSource, /pricing page/);
    }
    const report = run.report as any;
    assert.equal(report.ai.calls, 2);
    assert.equal(report.ai.estimatedCostUsd, calls[0].estimatedCostUsd + calls[1].estimatedCostUsd);
    const recorded = JSON.stringify(ledger.calls(TODAY));
    assert.ok(!recorded.includes("--- DOCUMENT ---") && !recorded.includes("Schedule note"), "no prompt or document text is recorded");
    assert.notEqual(scheduleState(store).textHash, undefined);
});

test("a repair is one extra call, recorded as a repair and counted against the limits", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const ai = scheduleAi(PARAPHRASED_ITEMS);
    const run = await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, NOW, { ai: gateFor(ai, { ledger }) });
    assert.equal(run.result.status, "fresh");
    assert.deepEqual(ai.requests.map(r => r.label), ["classify", "extract", "extract-repair"]);
    assert.deepEqual(ledger.calls(TODAY).map(c => [c.operation, c.repair]), [["classify", false], ["extract", false], ["extract-repair", true]]);
    assert.equal((run.report as any).ai.repairs, 1);

    const gate = gateFor(ai, { ledger });
    assert.equal(gate.check("lol", "next-patch", NOW, documentCallPlan(1000)).ok, false, "3 used + a 3-call worst case exceeds 5 per topic");
    assert.equal(gate.check("lol", "next-patch", NOW, documentCallPlan(1000).slice(0, 2)).ok, true);
});

test("an exhausted daily budget defers the work: no call, last known-good kept, the page not marked as seen, retried later", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, NOW, { ai: gateFor(scheduleAi(), { ledger }) });
    const before = store.load("lol");
    const hashBefore = scheduleState(store).textHash;

    // Other topics have spent today's estimated budget.
    ledger.record(spent({ game: "valorant", topic: "last-patch", estimatedCostUsd: 1.95 }));

    const ai = scheduleAi();
    const search = new MockSearchProvider("sitemap", "official", {});
    const run = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(CHANGED), { official: [search] }), store, new Date("2026-09-15T12:00:00Z"), { ai: gateFor(ai, { ledger }) });

    assert.equal(ai.requests.length, 0, "no model call");
    assert.equal(ledger.calls(TODAY).length, 3, "nothing new recorded");
    assert.equal(run.result.status, "stale");
    assert.equal((run.result as any).reason, "An updated official page is waiting to be verified", "visitors see no budget figures");
    assert.equal((run.result as any).reason_code, "budget-deferred");
    assert.match(run.deferred?.detail ?? "", /^AI budget exhausted \(daily-cost\)/);
    assert.equal((run.result as any).nextEventUtc, "2026-09-23T00:00:00.000Z", "last known-good stays published");
    assert.equal((run.result as any).notes, "Patch 26.19");
    assert.equal(run.deferred?.reason, "deferred_due_to_budget");
    assert.deepEqual(run.work, { unchanged: 0, deterministic: 0, sentToAi: 0, deferred: 1 });
    assert.equal(search.queries.length, 0, "no discovery while work is deferred");

    const k = store.load("lol");
    assert.equal(scheduleState(store).textHash, hashBefore, "the changed page is not marked as seen");
    assert.deepEqual(k.events, before.events);
    assert.deepEqual(k.documents, before.documents);
    assert.deepEqual(k.claims, before.claims);
    assert.deepEqual(k.discovered.map(d => d.failures), [0], "a deferred page is not a failed page");
    assert.equal(k.topicStates.length, 1);
    assert.equal(k.topicStates[0].deferred?.reason, "deferred_due_to_budget");
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k))));

    // A new UTC day has budget again: the same changed page is read, and the deferral clears.
    const retryAi = scheduleAi();
    const retry = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(CHANGED)), store, new Date("2026-09-16T00:05:00Z"), { ai: gateFor(retryAi, { ledger }) });
    assert.deepEqual(retryAi.requests.map(r => r.label), ["classify", "extract"]);
    assert.equal(retry.result.status, "fresh");
    assert.notEqual(scheduleState(store).textHash, hashBefore);
    assert.deepEqual(store.load("lol").topicStates, []);
});

test("an exhausted per-topic limit defers the same way, while other topics keep their budget", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, NOW, { ai: gateFor(scheduleAi(), { ledger }) });
    const before = store.load("lol");
    const hashBefore = scheduleState(store).textHash;
    for (let i = 0; i < 3; i++) ledger.record(spent({ estimatedCostUsd: 0.001 }));

    const ai = scheduleAi();
    const gate = gateFor(ai, { ledger });
    const run = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(CHANGED)), store, new Date("2026-09-15T12:00:00Z"), { ai: gate });
    assert.equal(ai.requests.length, 0);
    assert.equal(run.result.status, "stale");
    assert.equal((run.result as any).reason_code, "budget-deferred");
    assert.match(run.deferred?.detail ?? "", /^AI budget exhausted \(topic-calls\): lol\/next-patch used 5 of 5 calls today/);
    assert.equal((run.result as any).nextEventUtc, "2026-09-23T00:00:00.000Z");
    assert.equal(scheduleState(store).textHash, hashBefore);
    assert.deepEqual(store.load("lol").events, before.events);
    assert.equal(gate.check("valorant", "last-patch", NOW, documentCallPlan(5000)).ok, true, "the limit is per topic");
});

test("a budget refusal in the middle of a document (its repair) defers the whole document instead of keeping a partial answer", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const limits = { perTopicCalls: 10 };
    await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, NOW, { ai: gateFor(scheduleAi(), { ledger, limits }) });
    const before = store.load("lol");
    const hashBefore = scheduleState(store).textHash;

    // While this document is being extracted, other work uses up the topic's calls, so the repair is refused.
    const ai = scheduleAi(PARAPHRASED_ITEMS, req => {
        if (req.label === "extract") for (let i = 0; i < 6; i++) ledger.record(spent({ runId: "concurrent" }));
    });
    const run = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(CHANGED)), store, new Date("2026-09-15T12:00:00Z"), { ai: gateFor(ai, { ledger, limits }) });
    assert.deepEqual(ai.requests.map(r => r.label), ["classify", "extract"], "the repair was never sent");
    assert.equal(run.result.status, "stale");
    assert.equal((run.result as any).reason_code, "budget-deferred");
    assert.match(run.deferred?.detail ?? "", /topic-calls/);
    assert.deepEqual(run.work, { unchanged: 0, deterministic: 0, sentToAi: 1, deferred: 1 });
    const k = store.load("lol");
    assert.equal(scheduleState(store).textHash, hashBefore);
    assert.deepEqual(k.documents, before.documents, "the partial extraction is not stored as evidence");
    assert.deepEqual(k.claims, before.claims);
    assert.deepEqual(k.events, before.events);
});

test("the per-document plan covers what classification, extraction and repair really send", async () => {
    const ai = scheduleAi(PARAPHRASED_ITEMS);
    await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), tempStore().store, NOW, { ai: gateFor(ai) });
    const plan = documentCallPlan(0);
    assert.ok(plan[2].promptChars > plan[1].promptChars, "the repair reserves room for its corrections list");
    assert.deepEqual(ai.requests.map(r => r.label), ["classify", "extract", "extract-repair"]);
    ai.requests.forEach((req, i) => {
        const doc = req.prompt.match(/--- DOCUMENT ---\n([\s\S]*?)\n--- END ---/)?.[1] ?? "";
        assert.ok(doc.length > 1000, "the document is in the prompt");
        const overhead = req.system.length + req.prompt.length - doc.length;
        assert.ok(overhead <= plan[i].promptChars, `${req.label}: ${overhead} characters beyond the document fit the allowance of ${plan[i].promptChars}`);
        assert.equal(req.maxOutputTokens, plan[i].maxOutputTokens, `${req.label} output cap matches the plan`);
    });
    const worst = gateFor(ai).check("lol", "next-patch", NOW, discoveryCallPlan());
    assert.equal(worst.ok, true);
    assert.ok(worst.ok && worst.projectedCostUsd < 0.5, "a full-size worst case stays far below the daily ceiling");
});

test("discovery runs at most once a day per topic, sooner only when an event has passed or evidence is held", async () => {
    const event = (overrides: Partial<Event>): Event => ({
        key: "lol/next-patch/26.19", game: "lol", topic: "next-patch", kind: "version", label: "26.19", status: "ended",
        at: "2026-09-15T00:00:00.000Z", precision: "day", firstSeen: NOW.toISOString(), lastVerified: NOW.toISOString(), publishState: "published", ...overrides
    });
    const knowledge = emptyKnowledge("lol", NOW);
    assert.deepEqual(discoveryDue({ topic: TOPIC, knowledge, now: NOW }), { due: true, reason: "discovery has not run for this topic yet" });
    knowledge.topicStates.push({ topic: "next-patch", lastDiscoveryAt: "2026-09-15T06:00:00.000Z" });
    const sixHours = discoveryDue({ topic: TOPIC, knowledge, now: new Date("2026-09-15T12:00:00Z") });
    assert.equal(sixHours.due, false);
    assert.match(sixHours.reason, /next regular search is after 2026-09-16T06:00:00.000Z \(every 24 h\)/);
    assert.equal(discoveryDue({ topic: TOPIC, knowledge, now: new Date("2026-09-16T06:00:00Z") }).due, true);
    assert.equal(discoveryDue({ topic: { ...TOPIC, discovery: { ...TOPIC.discovery, minIntervalHours: 6 } }, knowledge, now: new Date("2026-09-15T12:00:00Z") }).due, true, "a topic can ask for a shorter cadence");

    // A patch day that ends between searches reopens the question at once.
    knowledge.events.push(event({}));
    assert.equal(discoveryDue({ topic: TOPIC, knowledge, now: new Date("2026-09-15T23:00:00Z") }).due, false);
    const reopened = discoveryDue({ topic: TOPIC, knowledge, now: new Date("2026-09-16T01:00:00Z") });
    assert.equal(reopened.due, true);
    assert.match(reopened.reason, /26\.19 passed after the last discovery/);

    const held = emptyKnowledge("lol", NOW);
    held.topicStates.push({ topic: "next-patch", lastDiscoveryAt: "2026-09-15T06:00:00.000Z" });
    held.events.push(event({ key: "lol/next-patch/26.20", label: "26.20", status: "scheduled", at: "2026-10-07T00:00:00.000Z", publishState: "held" }));
    assert.match(discoveryDue({ topic: TOPIC, knowledge: held, now: new Date("2026-09-15T12:00:00Z") }).reason, /held evidence/);

    // In the adapter: once the schedule has run out, discovery searches once, then waits for the next day.
    const { store } = tempStore();
    await runTracker(GAME, TOPIC, lolAdapter(lolTransport()), store, NOW, { ai: gateFor(scheduleAi()) });
    const search = new MockSearchProvider("sitemap", "official", {});
    const afterSchedule = new Date("2026-10-08T06:00:00Z");
    const firstAi = scheduleAi();
    const first = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(), { official: [search] }), store, afterSchedule, { ai: gateFor(firstAi) });
    assert.equal(first.result.status, "stale");
    assert.equal(firstAi.requests.length, 0, "the learned URL serves the content already extracted, so it is not read again");
    assert.deepEqual((first.report as any).attempts.map((a: any) => a.outcome), ["unchanged", "unchanged"]);
    const searched = search.queries.length;
    assert.ok(searched > 0);
    assert.equal(store.load("lol").topicStates[0].lastDiscoveryAt, afterSchedule.toISOString());

    const sameDay = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(), { official: [search] }), store, new Date("2026-10-08T12:00:00Z"), { ai: gateFor(scheduleAi()) });
    assert.equal(search.queries.length, searched, "no second search the same day");
    assert.equal(sameDay.result.status, "stale");
    assert.equal((sameDay.result as any).reason_code, "no-new-information");
    assert.match(sameDay.failureDetail ?? "", /discovery is not due/, "the detail stays internal");
    await runTracker(GAME, TOPIC, lolAdapter(lolTransport(), { official: [search] }), store, new Date("2026-10-09T06:00:00Z"), { ai: gateFor(scheduleAi()) });
    assert.ok(search.queries.length > searched, "the next day searches again");
});

test("the same content under a second URL is not sent to the model twice in one run", async () => {
    const pastOnly = new MockAiProvider("gemini-3.5-flash", (req: AiJsonRequest) => req.label === "classify" ? CLASSIFIED : { items: [SCHEDULE_ITEMS.items[0]] });
    const search = new MockSearchProvider("sitemap", "official", { "League of Legends patch schedule": [{ url: FINAL, title: "Patch Schedule - League of Legends", rank: 1, provider: "sitemap" }] });
    const run = await runTracker(GAME, TOPIC, lolAdapter(lolTransport(), { official: [search] }), tempStore().store, NOW, { ai: gateFor(pastOnly) });
    assert.deepEqual(pastOnly.requests.map(r => r.label), ["classify", "extract"]);
    assert.deepEqual((run.report as any).attempts.map((a: any) => a.outcome), ["no-answer", "duplicate"]);
    assert.equal(run.result.status, "unavailable");
});

test("the usage ledger persists per UTC day, and an unreadable day blocks calls without being overwritten", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-ledger-"));
    const first = AiUsageLedger.inDirectory(dir);
    first.record(spent({ estimatedCostUsd: 0.5 }));
    first.record(spent({ operation: "classify", success: false, retries: 2, estimatedCostUsd: 0.25, error: "Gemini API error 503" }));
    const reread = AiUsageLedger.inDirectory(dir);
    assert.deepEqual(reread.totals(TODAY), { calls: 2, failures: 1, repairs: 0, retries: 2, inputTokens: 2000, outputTokens: 2000, thoughtTokens: 0, estimatedCostUsd: 0.75 });
    assert.equal(reread.totals("2026-09-16").calls, 0, "a new UTC day starts empty");

    const file = path.join(dir, `${TODAY}.json`);
    fs.writeFileSync(file, "{ not json");
    const broken = AiUsageLedger.inDirectory(dir);
    const verdict = gateFor(scheduleAi(), { ledger: broken }).check("lol", "next-patch", NOW, documentCallPlan(1000));
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.reason, "ledger-unreadable");
    broken.record(spent());
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "an unreadable ledger is never silently replaced");
});

test("limits come from the environment with safe defaults, prices are central estimates, and each limit stops calls on its own", () => {
    assert.deepEqual(readAiBudgetLimits({}), { dailyCostUsd: 2, dailyCalls: 100, perTopicCalls: 5 });
    assert.deepEqual(readAiBudgetLimits({ AI_DAILY_COST_LIMIT_USD: "0.50", AI_DAILY_CALL_LIMIT: "20", AI_PER_TOPIC_CALL_LIMIT: "3" }), { dailyCostUsd: 0.5, dailyCalls: 20, perTopicCalls: 3 });
    assert.throws(() => readAiBudgetLimits({ AI_DAILY_CALL_LIMIT: "ten" }), /AI_DAILY_CALL_LIMIT/);
    assert.throws(() => readAiBudgetLimits({ AI_PER_TOPIC_CALL_LIMIT: "2.5" }), /integer/);
    assert.throws(() => readAiBudgetLimits({ AI_DAILY_COST_LIMIT_USD: "-1" }), /non-negative/);

    const flash = priceFor("gemini-3.5-flash", {})!;
    assert.deepEqual([flash.inputPerMillionUsd, flash.outputPerMillionUsd], [1.5, 9]);
    const cost = estimateCost(flash, { inputTokens: 1_000_000, outputTokens: 100_000, thoughtTokens: 100_000 });
    assert.ok(Math.abs(cost.inputUsd - 1.5) < 1e-9 && Math.abs(cost.outputUsd - 1.8) < 1e-9, "thinking tokens are billed as output");
    assert.equal(priceFor("some-future-model", {}), undefined, "an unknown model has no assumed price");
    assert.equal(priceFor("some-future-model", { AI_PRICE_INPUT_PER_M: "3", AI_PRICE_OUTPUT_PER_M: "15" })?.outputPerMillionUsd, 15);
    const unpriced = gateFor(new MockAiProvider("some-future-model", () => ({}))).check("lol", "next-patch", NOW, documentCallPlan(1000));
    assert.equal(!unpriced.ok && unpriced.reason, "unpriced-model", "calls to a model whose cost cannot be bounded are refused");
    assert.equal(priceFor("gemini-3.5-flash", { AI_PRICE_INPUT_PER_M: "0.75", AI_PRICE_OUTPUT_PER_M: "3.75" })?.outputPerMillionUsd, 3.75);
    assert.throws(() => priceFor("gemini-3.5-flash", { AI_PRICE_INPUT_PER_M: "1" }), /both/);

    const ledger = AiUsageLedger.inMemory();
    ledger.record(spent({ game: "cs2", topic: "last-update" }));
    const plan = documentCallPlan(8000);
    const reason = (limits: Partial<AiBudgetLimits>) => { const v = gateFor(scheduleAi(), { ledger, limits }).check("lol", "next-patch", NOW, plan); return v.ok ? "ok" : v.reason; };
    assert.equal(reason({}), "ok");
    assert.equal(reason({ dailyCalls: 3 }), "daily-calls");
    assert.equal(reason({ perTopicCalls: 2 }), "topic-calls");
    assert.equal(reason({ dailyCostUsd: 0.05 }), "daily-cost");
    assert.deepEqual(gateFor(scheduleAi(), { unavailable: "no ledger" }).check("lol", "next-patch", NOW, plan), { ok: false, reason: "budget-unavailable", detail: "no ledger" });
});

test("CI without the knowledge checkout makes no model call, because usage could be neither tracked nor kept", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-root-"));
    const { gate, unavailable } = createRunAiGate({ knowledgeRoot: root, env: { GITHUB_ACTIONS: "true" } });
    assert.match(unavailable ?? "", /knowledge branch is not checked out/);
    const verdict = gate.check("lol", "next-patch", NOW, documentCallPlan(1000));
    assert.equal(!verdict.ok && verdict.reason, "budget-unavailable");
    assert.equal(await gate.providerFor("lol", "next-patch", NOW), undefined, "no key in this environment: no provider");
    assert.equal(gate.ledger.location, usageLedgerDir(root));

    fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
    assert.equal(createRunAiGate({ knowledgeRoot: root, env: { GITHUB_ACTIONS: "true" } }).unavailable, undefined, "a checked-out worktree tracks usage");
    assert.match(createRunAiGate({ knowledgeRoot: root, env: { AI_DAILY_CALL_LIMIT: "lots" } }).unavailable ?? "", /invalid AI budget configuration/);
});

test("the run summary reports calls, tokens, estimated cost and remaining budget, and no request content", () => {
    const ledger = AiUsageLedger.inMemory();
    const gate = gateFor(undefined, { ledger, runId: "gha-1-1" });
    ledger.record(spent({ runId: "gha-1-1", operation: "classify", inputTokens: 2276, outputTokens: 50, estimatedInputCostUsd: 0.0034, estimatedOutputCostUsd: 0.0005, estimatedCostUsd: 0.0039 }));
    ledger.record(spent({ runId: "gha-1-1", operation: "extract", inputTokens: 2276, outputTokens: 2930, estimatedInputCostUsd: 0.0034, estimatedOutputCostUsd: 0.0264, estimatedCostUsd: 0.0298 }));
    ledger.record(spent({ runId: "earlier", estimatedCostUsd: 0.03 }));
    const summary = summarizeRun({
        gate, startedAt: NOW, finishedAt: NOW, calls: ledger.calls(TODAY).filter(r => r.runId === "gha-1-1"), trackers: [
            { game: "lol", type: "next-patch", engine: "v2", status: "fresh", work: { unchanged: 0, deterministic: 0, sentToAi: 1, deferred: 0 }, discovery: "skipped: next event already known" },
            { game: "roblox", type: "status", engine: "v2", status: "fresh", work: { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 } },
            { game: "gta", type: "weekly-reset", engine: "v2", status: "fresh", work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 } },
            { game: "cs2", type: "last-update", engine: "v1", status: "fresh" }
        ]
    });
    assert.equal(summary.run.calls, 2);
    assert.equal(summary.today.calls, 3);
    assert.equal(summary.remaining.calls, 97);
    assert.ok(Math.abs(summary.run.estimatedCostUsd - 0.0337) < 1e-9);
    assert.ok(Math.abs(summary.remaining.costUsd - (2 - 0.0637)) < 1e-9);
    assert.deepEqual(summary.documents, { unchanged: 1, deterministic: 1, sentToAi: 1, deferred: 0 });
    assert.equal(summary.trackers[0].ai.calls, 2);

    const md = renderRunSummary(summary);
    assert.match(md, /\| AI calls \| 2 \| 3 \| 100 \| 97 \|/);
    assert.match(md, /\| Estimated cost \| \$0\.0337 \| \$0\.0637 \| \$2\.00 \| \$1\.9363 \|/);
    assert.match(md, /Documents this run: 1 skipped unchanged, 1 handled deterministically, 1 sent to AI, 0 deferred by the budget\./);
    assert.match(md, /\| lol\/next-patch \| fresh \| 0 \| 0 \| 1 \| 0 \| 2 \| \$0\.0337 \| discovery: skipped: next event already known \|/);
    assert.match(md, /\| lol\/next-patch \| extract \| gemini \/ gemini-3\.5-flash \| 2276 \| 2930 \| \$0\.0034 \| \$0\.0264 \| \$0\.0298 \| ok \|/);
    assert.ok(!md.includes("cs2/"), "V1 trackers are not listed among V2 trackers");
    assert.match(md, /not billing data/);
});

test("the Gemini provider counts the tokens of unusable answers it retried, so their cost is recorded", async () => {
    const client = (answers: GeminiResponseLike[]): GeminiClientLike => {
        let i = 0;
        return { models: { async generateContent() { return answers[Math.min(i++, answers.length - 1)]; } } };
    };
    const REQUEST = { label: "extract", system: "s", prompt: "p", schema: {} };
    const notJson: GeminiResponseLike = { text: "not json", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 } };
    const ok: GeminiResponseLike = { text: "{\"ok\":true}", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } };

    const direct = await new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "gemini-3.5-flash", client: client([notJson, ok]), retryDelayMs: 0 }).generateJson(REQUEST);
    assert.deepEqual(direct.usage, { inputTokens: 200, outputTokens: 50, thoughtTokens: 0 });
    assert.equal(direct.retries, 1);

    const ledger = AiUsageLedger.inMemory();
    const retried = await gateFor(new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "gemini-3.5-flash", client: client([notJson, ok]), retryDelayMs: 0 }), { ledger }).providerFor("lol", "next-patch", NOW);
    await retried!.generateJson(REQUEST);
    const empty: GeminiResponseLike = { text: "", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 } };
    const failing = await gateFor(new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "gemini-3.5-flash", client: client([empty]), retryDelayMs: 0, maxRetries: 1 }), { ledger }).providerFor("lol", "next-patch", NOW);
    await assert.rejects(() => failing!.generateJson({ ...REQUEST, label: "classify" }), (e: unknown) => e instanceof AiError && e.retries === 1 && e.usage?.inputTokens === 200);

    const [success, failure] = ledger.calls(TODAY);
    assert.deepEqual([success.success, success.retries, success.inputTokens, success.outputTokens], [true, 1, 200, 50]);
    assert.deepEqual([failure.success, failure.retries, failure.inputTokens, failure.operation], [false, 1, 200, "classify"]);
    assert.ok(failure.estimatedCostUsd > 0, "billed attempts of a failed call still cost");
    assert.match(failure.error ?? "", /empty response/);
    assert.ok(!JSON.stringify(ledger.calls(TODAY)).includes("AIzaSecretKey123"));
});

test("the cost projection reserves every attempt a provider may send for one call", async () => {
    const ok: GeminiResponseLike = { text: "{\"ok\":true}", candidates: [{ finishReason: "STOP" }] };
    const retrying = new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "gemini-3.5-flash", client: { models: { async generateContent() { return ok; } } }, retryDelayMs: 0, maxRetries: 2 });
    assert.equal(retrying.maxAttempts, 3);
    const plan = documentCallPlan(1000);

    const once = gateFor(scheduleAi(), { limits: { dailyCostUsd: 0.5 } });
    await once.providerFor("lol", "next-patch", NOW);
    const single = once.check("lol", "next-patch", NOW, plan);
    assert.equal(single.ok, true, "one attempt per call fits");

    const thrice = gateFor(retrying, { limits: { dailyCostUsd: 0.5 } });
    const budgeted = await thrice.providerFor("lol", "next-patch", NOW);
    assert.equal(budgeted!.maxAttempts, 3);
    const verdict = thrice.check("lol", "next-patch", NOW, plan);
    assert.equal(!verdict.ok && verdict.reason, "daily-cost");
    assert.match(!verdict.ok ? verdict.detail : "", /each call may take up to 3 attempts/);
    const one = once.check("lol", "next-patch", NOW, plan.slice(0, 1));
    const three = thrice.check("lol", "next-patch", NOW, plan.slice(0, 1));
    assert.ok(one.ok && three.ok && Math.abs(three.projectedCostUsd - 3 * one.projectedCostUsd) < 1e-12, "three attempts reserve three times the cost");
});

test("the budget day is read when each call is made, so a run crossing UTC midnight counts later calls against the new day", async () => {
    const ledger = AiUsageLedger.inMemory();
    ledger.record(spent({ estimatedCostUsd: 1.99 }));
    const clock = { now: new Date("2026-09-16T00:01:00Z") };
    const gate = createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "midnight", model: "gemini-3.5-flash", loadProvider: async () => scheduleAi(), env: {}, clock: () => clock.now });
    const trackerStarted = new Date("2026-09-15T23:59:00Z");
    assert.equal(gate.check("lol", "next-patch", trackerStarted, documentCallPlan(1000)).ok, true, "the new day has its own budget");

    const provider = await gate.providerFor("lol", "next-patch", trackerStarted);
    await provider!.generateJson({ label: "classify", system: "s", prompt: "p", schema: {} });
    assert.deepEqual(ledger.calls("2026-09-16").map(c => c.at), ["2026-09-16T00:01:00.000Z"]);
    assert.equal(ledger.calls(TODAY).length, 1, "the previous day keeps only its own call");
    assert.equal(gate.callsMade("lol", "next-patch").length, 1);
    assert.equal(gate.callsMade("gta", "weekly-reset").length, 0);

    clock.now = new Date("2026-09-15T23:59:30Z");
    assert.equal(gate.check("lol", "next-patch", trackerStarted, documentCallPlan(1000)).ok, false, "before midnight the nearly spent day applies");
});

test("topic state is validated, and knowledge files written before it existed still load", () => {
    const legacy = JSON.parse(JSON.stringify(emptyKnowledge("lol", NOW)));
    delete legacy.topicStates;
    assert.deepEqual(validateGameKnowledge(legacy).topicStates, []);
    const badReason = { ...emptyKnowledge("lol", NOW), topicStates: [{ topic: "next-patch", deferred: { reason: "because", detail: "x", at: NOW.toISOString() } }] };
    assert.throws(() => validateGameKnowledge(JSON.parse(JSON.stringify(badReason))), /reason/);
    const duplicate = { ...emptyKnowledge("lol", NOW), topicStates: [{ topic: "a" }, { topic: "a" }] };
    assert.throws(() => validateGameKnowledge(JSON.parse(JSON.stringify(duplicate))), /duplicate topic state/);
});
