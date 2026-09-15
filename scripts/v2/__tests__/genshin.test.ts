/**
 * Genshin Impact on V2: HoYoverse's official announcement list per server region -> "Event Wish" phases with
 * server wall-clock end times -> one event at the earliest regional end, naming all three regional instants ->
 * KnowledgeStore -> V1-compatible view.
 * The fixtures are trimmed live responses captured on 2026-09-16 (entries unchanged).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GENSHIN_NEWS_PAGE, GENSHIN_REGIONS, createGenshinWishAdapter, genshinAnnouncementsUrl, parseWishPhases } from "../adapters/genshin";
import { MockAiProvider } from "../ai/mock";
import { DEFAULT_AI_BUDGET_LIMITS, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";
import { routedTransport } from "./routed-transport";

const game = findGame("genshin");
const topic = findTopic(game, "next-banner");
const ASIA = fixture("genshin-announcements-os_asia.json");
const EURO = fixture("genshin-announcements-os_euro.json");
const USA = fixture("genshin-announcements-os_usa.json");
const NOW = new Date("2026-09-16T00:00:00Z");
const KEY = "genshin/next-banner/event-wishes-2026-09-22-14-59-59";

const transportFor = (bodies: { asia?: string; euro?: string; usa?: string } = {}) => routedTransport({
    [genshinAnnouncementsUrl("os_asia")]: { body: bodies.asia ?? ASIA, headers: { "content-type": "application/json" } },
    [genshinAnnouncementsUrl("os_euro")]: { body: bodies.euro ?? EURO, headers: { "content-type": "application/json" } },
    [genshinAnnouncementsUrl("os_usa")]: { body: bodies.usa ?? USA, headers: { "content-type": "application/json" } }
});

function noModelGate(ledger: AiUsageLedger) {
    const model = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("announcements must never reach the model"); });
    return { model, gate: createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "genshin-test", model: model.model, loadProvider: async () => model, env: {} }) };
}

test("each region's wish phase end is converted with the offset that region's own response states", () => {
    const asia = parseWishPhases(ASIA);
    const euro = parseWishPhases(EURO);
    const usa = parseWishPhases(USA);
    assert.deepEqual([asia.timezone, euro.timezone, usa.timezone], [8, 1, -5]);
    assert.deepEqual([asia.phases.length, euro.phases.length, usa.phases.length], [1, 1, 1]);
    assert.equal(asia.phases[0].endWall, "2026-09-22 14:59:59", "the same server wall clock in every region");
    assert.deepEqual([asia.phases[0].endAt, euro.phases[0].endAt, usa.phases[0].endAt], ["2026-09-22T06:59:59.000Z", "2026-09-22T13:59:59.000Z", "2026-09-22T19:59:59.000Z"]);
    assert.deepEqual(asia.phases[0].names, ["The Lone Light Knocks at Night", "Astral Actuation", "Epitome Invocation"]);
    assert.deepEqual(asia.phases[0].annIds, [21805, 21806, 21808]);
    assert.ok(ASIA.includes(asia.phases[0].excerpt), "the excerpt is a slice of the fetched response");
    assert.equal(JSON.parse(asia.phases[0].excerpt).ann_id, 21805);
});

test("a response that is not the announcement shape is rejected", () => {
    assert.throws(() => parseWishPhases("<html>maintenance</html>"), /Invalid JSON/);
    assert.throws(() => parseWishPhases(JSON.stringify({ retcode: -1, message: "busy", data: null })), /retcode -1/);
    const noZone = JSON.parse(ASIA);
    delete noZone.data.timezone;
    assert.throws(() => parseWishPhases(JSON.stringify(noZone)), /data.timezone/);
});

test("the earliest regional end is published with all three regional instants named; an unchanged run changes nothing", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { model, gate } = noModelGate(ledger);

    const first = await runTracker(game, topic, createGenshinWishAdapter(transportFor()), store, NOW, { ai: gate });
    assert.equal(first.result.status, "fresh");
    const fresh = first.result as Extract<typeof first.result, { status: "fresh" }>;
    assert.deepEqual(Object.keys(fresh), V1_ROBLOX_FRESH_KEYS);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["genshin", "genshin", "next-banner", "Genshin Impact Next Banner End"], "same data file and page as V1");
    assert.equal(fresh.nextEventUtc, "2026-09-22T06:59:59.000Z", "the earliest regional end: nobody is told they have more time than they do");
    assert.match(fresh.notes!, /The Lone Light Knocks at Night \/ Astral Actuation \/ Epitome Invocation/);
    assert.match(fresh.notes!, /ends 2026-09-22 14:59 server time \(Asia 06:59 UTC, Europe 13:59 UTC, America 19:59 UTC\)/);
    assert.equal(fresh.source_url, GENSHIN_NEWS_PAGE);
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 3, sentToAi: 0, deferred: 0 });

    const k1 = store.load("genshin");
    assert.deepEqual(k1.events.map(e => [e.key, e.status, e.at, e.precision]), [[KEY, "scheduled", "2026-09-22T06:59:59.000Z", "exact"]]);
    assert.deepEqual(k1.sources.map(s => s.id).sort(), GENSHIN_REGIONS.map(r => `genshin-announcements-${r.region}`).sort());
    assert.deepEqual([k1.documents.length, k1.claims.length], [1, 1]);
    assert.ok(ASIA.includes(k1.claims[0].quote!));
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, createGenshinWishAdapter(transportFor()), store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
    assert.deepEqual(second.work, { unchanged: 3, deterministic: 0, sentToAi: 0, deferred: 0 });
    assert.equal(model.requests.length, 0);
    assert.equal(ledger.calls("2026-09-16").length, 0);
});

test("regions that disagree about a phase keep the stored banner end as stale", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createGenshinWishAdapter(transportFor()), store, NOW);
    const shifted = EURO.split("2026-09-22 14:59:59").join("2026-09-23 14:59:59");
    const run = await runTracker(game, topic, createGenshinWishAdapter(transportFor({ euro: shifted })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(run.result.status, "stale");
    assert.match((run.result as any).reason, /not listed in every region/);
    assert.equal((run.result as any).nextEventUtc, "2026-09-22T06:59:59.000Z");
});

test("once the earliest regional end has passed the phase is ended", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createGenshinWishAdapter(transportFor()), store, NOW);
    const after = await runTracker(game, topic, createGenshinWishAdapter(transportFor()), store, new Date("2026-09-22T08:00:00Z"));
    assert.equal(store.load("genshin").events.find(e => e.key === KEY)!.status, "ended");
    assert.equal((after.result as any).nextEventUtc, "2026-09-22T06:59:59.000Z", "until the next phase is announced, the ended phase stays the latest known");
});

test("the production registry runs Genshin on the regional announcement adapter", () => {
    assert.deepEqual(game.sources.map(s => s.id).sort(), GENSHIN_REGIONS.map(r => `genshin-announcements-${r.region}`).sort());
    assert.equal(topic.view.linkEvidence, false);
    assert.equal(typeof adapterFor(topic), "function");
});
