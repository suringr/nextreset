/**
 * Warzone on V2: official Call of Duty patch notes page -> the Warzone card's data-date and article link ->
 * a day-precision event keyed by article and update day, with evidence quoting the fetched page -> V1-compatible view.
 * The fixture is the real page captured on 2026-09-16 with script and style bodies emptied (markup unchanged).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WARZONE_PATCH_NOTES_URL, createWarzonePatchAdapter, parseCardDate, parseWarzoneUpdate } from "../adapters/warzone";
import { MockAiProvider } from "../ai/mock";
import { DEFAULT_AI_BUDGET_LIMITS, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fakeTransport, fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";

const game = findGame("warzone");
const topic = findTopic(game, "last-patch");
const PAGE = fixture("callofduty-patchnotes.html");
const SLUG = "call-of-duty-bo7-warzone-season-05-reloaded-patch-notes";
const LATEST = {
    identity: `${SLUG}-2026-08-28`,
    at: "2026-08-28T00:00:00.000Z",
    title: "Call of Duty: Warzone Season 05 Reloaded Patch Notes",
    url: `https://www.callofduty.com/patchnotes/2026/08/${SLUG}`
};
const NOW = new Date("2026-09-16T00:00:00Z");

function noModelGate(ledger: AiUsageLedger) {
    const model = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("the patch notes page must never reach the model"); });
    return { model, gate: createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "warzone-test", model: model.model, loadProvider: async () => model, env: {} }) };
}

test("card dates are read strictly as days", () => {
    assert.equal(parseCardDate("August 28, 2026"), "2026-08-28T00:00:00.000Z");
    assert.equal(parseCardDate("September 01, 2026"), "2026-09-01T00:00:00.000Z");
    assert.equal(parseCardDate("February 30, 2026"), undefined, "no rollover into March");
    assert.equal(parseCardDate("Last updated: ..."), undefined);
    assert.equal(parseCardDate("28/08/2026"), undefined);
});

test("the Warzone card wins over the Black Ops and Modern Warfare cards and the older-notes list, quoted verbatim", () => {
    const update = parseWarzoneUpdate(PAGE);
    assert.deepEqual([update.identity, update.at, update.dataDate, update.url, update.title], [LATEST.identity, LATEST.at, "August 28, 2026", LATEST.url, LATEST.title]);
    assert.notEqual(update.at, "2026-08-12T00:00:00.000Z", "not the Season 05 notes from the older-notes list that V1 published");
    assert.ok(PAGE.includes(update.excerpt), "the excerpt is a slice of the fetched page");
    assert.match(update.excerpt, /^<li\b[^>]*game-tile warzone/);
    assert.match(update.excerpt, /data-date="August 28, 2026"[^>]*>$/);
});

test("a page without exactly one dated Warzone card with an article link is rejected", () => {
    assert.throws(() => parseWarzoneUpdate(PAGE.replace("game-tile warzone", "game-tile bo7")), /found 0/);
    assert.throws(() => parseWarzoneUpdate(PAGE.replace("data-date=\"August 28, 2026\"", "data-date=\"soon\"")), /Unrecognized Warzone card date/);
    assert.throws(() => parseWarzoneUpdate("<html><body>Access denied</body></html>"), /found 0/);
});

test("the first run publishes the current Warzone update at day precision with a link to the article; an unchanged run changes nothing", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { model, gate } = noModelGate(ledger);
    const transport = fakeTransport({ http: [{ body: PAGE, headers: { "content-type": "text/html; charset=utf-8" } }] });
    const adapter = createWarzonePatchAdapter(transport);

    const first = await runTracker(game, topic, adapter, store, NOW, { ai: gate });
    assert.equal(transport.gets[0].url, WARZONE_PATCH_NOTES_URL);
    assert.equal(first.result.status, "fresh");
    const fresh = first.result as Extract<typeof first.result, { status: "fresh" }>;
    assert.deepEqual(Object.keys(fresh), V1_ROBLOX_FRESH_KEYS);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["warzone", "warzone", "last-patch", "Call of Duty Warzone Last Patch"], "same data file and page as V1");
    assert.deepEqual([fresh.nextEventUtc, fresh.notes, fresh.source_url, fresh.confidence], [LATEST.at, LATEST.title, LATEST.url, "high"]);

    const k1 = store.load("warzone");
    assert.deepEqual(k1.events.map(e => [e.key, e.precision, e.timezone]), [[`warzone/last-patch/${LATEST.identity}`, "day", undefined]], "day precision: the page states no time or time zone");
    assert.deepEqual([k1.documents.length, k1.claims.length], [1, 1]);
    assert.deepEqual([k1.documents[0].id, k1.documents[0].url], [k1.sources[0].textHash, WARZONE_PATCH_NOTES_URL]);
    assert.deepEqual([k1.claims[0].value, k1.claims[0].linkUrl, k1.claims[0].method], [LATEST.at, LATEST.url, "deterministic"]);
    assert.ok(PAGE.includes(k1.claims[0].quote!));
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
    assert.equal(model.requests.length, 0);
    assert.equal(ledger.calls("2026-09-16").length, 0);
});

test("an in-place article update becomes a new event; a broken page keeps the last update published as stale", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createWarzonePatchAdapter(fakeTransport({ http: [{ body: PAGE }] })), store, NOW);

    const updated = PAGE.replace("data-date=\"August 28, 2026\"", "data-date=\"September 15, 2026\"");
    const run = await runTracker(game, topic, createWarzonePatchAdapter(fakeTransport({ http: [{ body: updated }] })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal((run.result as any).nextEventUtc, "2026-09-15T00:00:00.000Z");
    assert.equal(run.created, 1);
    assert.deepEqual(store.load("warzone").events.map(e => e.key).sort(), [`warzone/last-patch/${SLUG}-2026-08-28`, `warzone/last-patch/${SLUG}-2026-09-15`]);

    const goodHash = store.load("warzone").sources[0].textHash;
    const broken = await runTracker(game, topic, createWarzonePatchAdapter(fakeTransport({ http: [{ body: updated.replace("game-tile warzone", "game-tile mw4") }] })), store, new Date("2026-09-16T12:00:00Z"));
    assert.equal(broken.result.status, "stale");
    assert.equal((broken.result as any).nextEventUtc, "2026-09-15T00:00:00.000Z");
    assert.deepEqual([store.load("warzone").sources[0].lastVerdict, store.load("warzone").sources[0].textHash], ["parse-error", goodHash]);
});

test("the production registry runs Warzone on the patch notes page adapter", () => {
    assert.equal(game.sources[0].url, WARZONE_PATCH_NOTES_URL);
    assert.equal(topic.discovery, undefined, "a deterministic page source needs no discovery");
    assert.equal(typeof adapterFor(topic), "function");
});
