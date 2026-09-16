/**
 * EA SPORTS FC on V2: Steam news for each title year (EA's community announcements) -> versioned title update posts ->
 * events keyed by title year and version, combined across years -> KnowledgeStore -> V1-compatible view.
 * Fixtures: FC 26 (app 3405690) posts from 2026-02 onward and FC 27 (app 4080220) posts, captured on 2026-09-16.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EAFC_PAGE, EAFC_TITLE_YEARS, createEafcTitleUpdateAdapter, eafcNewsUrl, eafcSourceId, parseEafcTitleUpdates } from "../adapters/eafc";
import { MockAiProvider } from "../ai/mock";
import { DEFAULT_AI_BUDGET_LIMITS, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";
import { routedTransport } from "./routed-transport";

const game = findGame("ea-sports-fc");
const topic = findTopic(game, "last-title-update");
const FC26 = fixture("steam-eafc26-news-api.json");
const FC27 = fixture("steam-eafc27-news-api.json");
const NOW = new Date("2026-09-16T00:00:00Z");

type Item = Record<string, unknown>;
const item = (overrides: Item): Item => ({
    gid: "1845000000000101", title: "EA SPORTS FC 27 Title Update 1.0.1", url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1845000000000101",
    is_external_url: true, author: "EA", contents: "Title Update 1.0.1 is now available {PC}.", feedlabel: "Community Announcements", date: 1790409600,
    feedname: "steam_community_announcements", feed_type: 1, appid: 4080220, tags: [], ...overrides
});
const withItem = (feed: string, extra: Item) => { const d = JSON.parse(feed); d.appnews.newsitems.unshift(extra); return JSON.stringify(d); };
const latestFc26 = () => (JSON.parse(FC26).appnews.newsitems as Array<{ gid: string; url: string; title: string }>).find(i => i.title === "EA SPORTS FC 26 version 1.6.5")!;

const transportFor = (bodies: { fc27?: string; fc26?: string; fc27Headers?: Record<string, string> } = {}) => routedTransport({
    [eafcNewsUrl(4080220)]: { body: bodies.fc27 ?? FC27, headers: bodies.fc27Headers ?? { "content-type": "application/json" } },
    [eafcNewsUrl(3405690)]: { body: bodies.fc26 ?? FC26, headers: { "content-type": "application/json" } }
});

function noModelGate(ledger: AiUsageLedger) {
    const model = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("Steam news must never reach the model"); });
    return { model, gate: createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "eafc-test", model: model.model, loadProvider: async () => model, env: {} }) };
}

test("versioned title update posts are read per title year at their exact publication time", () => {
    const fc26 = parseEafcTitleUpdates(FC26, 26);
    assert.deepEqual(fc26.map(p => [p.identity, p.at]), [
        ["fc26-1.6.5", "2026-07-22T14:00:01.000Z"],
        ["fc26-1.6.4", "2026-07-14T12:10:49.000Z"],
        ["fc26-1.6.2", "2026-06-16T12:07:08.000Z"],
        ["fc26-1.6.1", "2026-06-03T10:37:08.000Z"],
        ["fc26-1.5.6", "2026-05-12T11:47:47.000Z"],
        ["fc26-1.5.4", "2026-04-28T11:34:00.000Z"],
        ["fc26-1.5.3", "2026-04-07T09:32:06.000Z"],
        ["fc26-1.5.2", "2026-03-30T13:24:02.000Z"],
        ["fc26-1.5.1", "2026-03-24T13:31:38.000Z"],
        ["fc26-1.5.0", "2026-03-04T16:54:48.000Z"],
        ["fc26-1.4.2", "2026-02-03T12:52:46.000Z"]
    ], "version-only titles are title updates; feedback updates, unversioned updates and the FC 27 cross-post are not");
    assert.deepEqual(parseEafcTitleUpdates(FC27, 27), [], "FC 27 has not posted a title update yet");
    for (const p of fc26) assert.ok(FC26.includes(p.excerpt));
});

test("each title year's pattern accepts only its own year's versioned updates", () => {
    const mixed = withItem(withItem(FC26, item({ gid: "1", title: "FC 27 v1.0.1 Update" })), item({ gid: "2", title: "EA SPORTS FC™ 26 | September Feedback Update 1.6" }));
    assert.deepEqual(parseEafcTitleUpdates(mixed, 26).map(p => p.identity).slice(0, 1), ["fc26-1.6.5"], "an FC 27 title and a feedback post are ignored by the FC 26 feed");
    assert.deepEqual(parseEafcTitleUpdates(withItem(FC27, item({})), 27).map(p => p.identity), ["fc27-1.0.1"]);
});

test("a title update needs a version marked by v, version or update", () => {
    const read = (title: string) => parseEafcTitleUpdates(withItem(FC27, item({ title })), 27).map(p => p.identity);
    assert.deepEqual(read("EA SPORTS FC 27 version 1.0.3"), ["fc27-1.0.3"], "a version-only title is a title update");
    assert.deepEqual(read("EA SPORTS FC 27 v1.0.3"), ["fc27-1.0.3"]);
    assert.deepEqual(read("FC 27 Holiday Update (v1.3.0)"), ["fc27-1.3.0"]);
    assert.deepEqual(read("EA SPORTS FC 27 Title Update 1.0.3"), ["fc27-1.0.3"]);
    assert.deepEqual(read("EA SPORTS FC 27 - Match Outcomes Update"), [], "an unversioned update is not a title update");
    assert.deepEqual(read("EA SPORTS FC 27 Ratings Refresh 2.5"), [], "a number without a version marker is not a version");
});

test("today the last FC 26 title update is published; an unchanged run changes nothing and makes no model call", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { model, gate } = noModelGate(ledger);

    const first = await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor()), store, NOW, { ai: gate });
    assert.equal(first.result.status, "fresh");
    const fresh = first.result as Extract<typeof first.result, { status: "fresh" }>;
    assert.deepEqual(Object.keys(fresh), [...V1_ROBLOX_FRESH_KEYS, "precision"]);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["ea-sports-fc", "ea-sports-fc", "last-title-update", "EA SPORTS FC Last Title Update"], "same data file and page as V1");
    assert.deepEqual([fresh.nextEventUtc, fresh.notes, fresh.source_url, fresh.confidence], ["2026-07-22T14:00:01.000Z", "EA SPORTS FC 26 version 1.6.5", latestFc26().url, "high"]);
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 2, sentToAi: 0, deferred: 0 });

    const k1 = store.load("ea-sports-fc");
    assert.equal(k1.events.length, 11);
    assert.deepEqual(k1.sources.map(s => s.id).sort(), EAFC_TITLE_YEARS.map(t => eafcSourceId(t.year)).sort());
    assert.deepEqual([k1.documents.length, k1.claims.length], [1, 11], "only the FC 26 response holds evidence");
    assert.equal(k1.documents[0].sourceId, eafcSourceId(26));
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor()), store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
    assert.deepEqual(second.work, { unchanged: 2, deterministic: 0, sentToAi: 0, deferred: 0 });
    assert.equal(model.requests.length, 0);
    assert.equal(ledger.calls("2026-09-16").length, 0);
});

test("the new title year's first title update takes over by date", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor()), store, NOW);
    const launched = await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor({ fc27: withItem(FC27, item({})) })), store, new Date("2026-09-27T00:00:00Z"));
    assert.equal(launched.result.status, "fresh");
    assert.deepEqual([(launched.result as any).nextEventUtc, (launched.result as any).notes], [new Date(1790409600 * 1000).toISOString(), "EA SPORTS FC 27 Title Update 1.0.1"]);
    assert.equal(launched.created, 1);
    const k = store.load("ea-sports-fc");
    assert.ok(k.events.some(e => e.key === "ea-sports-fc/last-title-update/fc27-1.0.1"));
    assert.ok(k.events.some(e => e.key === "ea-sports-fc/last-title-update/fc26-1.6.5"), "the previous year's history stays");
});

test("a feed that has produced title updates and stops matching keeps the topic stale", async () => {
    const { store } = tempStore();
    const withFc27 = withItem(FC27, item({}));
    const both = await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor({ fc27: withFc27 })), store, new Date("2026-09-27T00:00:00Z"));
    assert.equal(both.result.status, "fresh");

    // EA renames FC 26's posts so none are recognised, while FC 27's title update still is.
    const renamed = FC26.split("FC 26").join("FC 2026");
    const broken = await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor({ fc26: renamed, fc27: withFc27 })), store, new Date("2026-09-27T06:00:00Z"));
    assert.equal(broken.result.status, "stale", "the other feed's older posts must not stand in for the renamed feed");
    assert.equal((broken.result as any).reason_code, "no-new-information");
    assert.match(broken.failureDetail ?? "", /^eafc-steam-fc26: /);
    assert.equal((broken.result as any).nextEventUtc, new Date(1790409600 * 1000).toISOString(), "FC 27's title update stays published");
});

test("a title year with no update yet may stay empty, and an unrelated post there keeps the topic fresh", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor()), store, NOW);
    const chatter = withItem(FC27, item({ gid: "7", title: "EA SPORTS FC 27 Pitch Notes", contents: "Nothing versioned here." }));
    const run = await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor({ fc27: chatter })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(run.result.status, "fresh", "FC 27 has never posted a title update, so its feed may hold none");
    assert.deepEqual([run.created, run.changes.length], [0, 0]);
    assert.equal((run.result as any).nextEventUtc, "2026-07-22T14:00:01.000Z");
});

test("a blocked feed keeps the last title update published as stale", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor()), store, NOW);
    const blocked = await runTracker(game, topic, createEafcTitleUpdateAdapter(transportFor({ fc27: "<html><body>Just a moment...</body></html>", fc27Headers: { "content-type": "text/html" } })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(blocked.result.status, "stale");
    assert.equal((blocked.result as any).reason_code, "source-blocked", "a challenge page is a refusal, not a broken page");
    assert.match(blocked.failureDetail ?? "", /^eafc-steam-fc27: /);
    assert.equal((blocked.result as any).nextEventUtc, "2026-07-22T14:00:01.000Z");
});

test("the production registry reads one Steam feed per title year, newest first", () => {
    assert.deepEqual(game.sources.map(s => [s.id, s.url]), EAFC_TITLE_YEARS.map(t => [eafcSourceId(t.year), eafcNewsUrl(t.appId)]));
    assert.equal(topic.view.sourceUrl, EAFC_PAGE);
    assert.equal(typeof adapterFor(topic), "function");
});
