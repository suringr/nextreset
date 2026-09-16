/**
 * PUBG on V2: Steam news API (the publisher's community announcements) -> posts titled exactly
 * "Patch Notes - Update <version>" -> events keyed by version with evidence quoting the fetched
 * response -> KnowledgeStore -> V1-compatible view.
 * The fixture is a real response (100 announcements, 2026-05-27 to 2026-09-15) captured on 2026-09-16.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PUBG_NEWS_URL, PUBG_PATCH_NOTES_PAGE, createPubgPatchAdapter, parsePubgPatches } from "../adapters/pubg";
import { MockAiProvider } from "../ai/mock";
import { DEFAULT_AI_BUDGET_LIMITS, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fakeTransport, fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";

const game = findGame("pubg");
const topic = findTopic(game, "last-patch");
const FEED = fixture("steam-pubg-news-api.json");
const LATEST = {
    identity: "43.1",
    at: "2026-09-09T06:00:17.000Z",
    title: "Patch Notes - Update 43.1",
    url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1843481262688119"
};
const NOW = new Date("2026-09-16T00:00:00Z");

type Item = Record<string, unknown>;
const item = (overrides: Item): Item => ({
    gid: "1845000000000001", title: "Patch Notes - Update 44.1", url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1845000000000001",
    is_external_url: true, author: "PUBG", contents: "Read the full announcement here! {braces} in a body", feedlabel: "Community Announcements", date: 1791525600,
    feedname: "steam_community_announcements", feed_type: 1, appid: 578080, tags: [], ...overrides
});
const feedWith = (items: Item[]) => JSON.stringify({ appnews: { appid: 578080, newsitems: items, count: items.length } });

function noModelGate(ledger: AiUsageLedger) {
    const model = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("Steam news must never reach the model"); });
    return { model, gate: createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "pubg-test", model: model.model, loadProvider: async () => model, env: {} }) };
}

test("only patch notes posts are events, keyed by version, at their exact publication time, each quoted verbatim", () => {
    const posts = parsePubgPatches(FEED);
    assert.deepEqual(posts.map(p => [p.identity, p.at]), [
        ["43.1", "2026-09-09T06:00:17.000Z"],
        ["42.3", "2026-08-11T06:00:47.000Z"],
        ["42.2", "2026-07-14T06:00:33.000Z"],
        ["42.1", "2026-06-16T06:00:51.000Z"]
    ], "store updates and map service reports published the same second are not patches");
    assert.deepEqual([posts[0].title, posts[0].url], [LATEST.title, LATEST.url]);
    const items = JSON.parse(FEED).appnews.newsitems as Array<{ gid: string }>;
    for (const post of posts) {
        assert.ok(FEED.includes(post.excerpt), `${post.identity}: the excerpt is a slice of the response`);
        assert.deepEqual(JSON.parse(post.excerpt), items.find(i => i.gid === post.gid));
    }
});

test("store, map service, event, dev letter, press and malformed posts are ignored, and a re-post keeps the first publication", () => {
    const posts = parsePubgPatches(feedWith([
        item({ gid: "1", title: "Map Service Report - Update 44.1" }),
        item({ gid: "2", title: "October Store Update 2026" }),
        item({ gid: "3", title: "Update #44.2 New Mode: PUBG x PAYDAY" }),
        item({ gid: "4", title: "[Dev Letter] The road to Update 44.1" }),
        item({ gid: "5", feedname: "PC Gamer", feed_type: 0 }),
        item({ gid: "not-a-gid" }),
        item({ gid: "7", date: 1791525600 }),
        item({ gid: "8", date: 1791612000 }),
        item({ gid: "9", title: "Patch Notes - Update 44.2", date: 1792130400, url: "javascript:alert(1)" })
    ]));
    assert.deepEqual(posts.map(p => [p.identity, p.gid, p.url]), [
        ["44.2", "9", PUBG_PATCH_NOTES_PAGE],
        ["44.1", "7", String(item({}).url)]
    ], "44.1 was re-posted a day later; the original publication is the patch date");
    assert.throws(() => parsePubgPatches("<html>challenge</html>"), /Invalid JSON/);
    assert.throws(() => parsePubgPatches("{}"), /No appnews.newsitems/);
});

test("the first run publishes the latest patch at its exact time with a link to the post; an unchanged run changes nothing and makes no model call", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { model, gate } = noModelGate(ledger);
    const transport = fakeTransport({ http: [{ body: FEED, headers: { "content-type": "application/json; charset=UTF-8" } }] });
    const adapter = createPubgPatchAdapter(transport);

    const first = await runTracker(game, topic, adapter, store, NOW, { ai: gate });
    assert.equal(transport.gets[0].url, PUBG_NEWS_URL);
    assert.equal(first.result.status, "fresh");
    const fresh = first.result as Extract<typeof first.result, { status: "fresh" }>;
    assert.deepEqual(Object.keys(fresh), [...V1_ROBLOX_FRESH_KEYS, "precision"]);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["pubg", "pubg", "last-patch", "PUBG Last Patch"], "same data file and page as V1");
    assert.equal(fresh.nextEventUtc, LATEST.at, "the exact post time, not midnight of the day");
    assert.equal(fresh.notes, LATEST.title);
    assert.equal(fresh.source_url, LATEST.url, "links to the patch notes post itself");
    assert.deepEqual([fresh.confidence, fresh.fetch_mode, fresh.http_status], ["high", "http", 200]);
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });

    const k1 = store.load("pubg");
    assert.deepEqual(k1.events.map(e => e.key).sort(), ["pubg/last-patch/42.1", "pubg/last-patch/42.2", "pubg/last-patch/42.3", "pubg/last-patch/43.1"]);
    assert.ok(k1.events.every(e => e.status === "observed" && e.precision === "exact" && e.timezone === "UTC"));
    assert.deepEqual([k1.documents.length, k1.claims.length], [1, 4], "one document (the fetched response), one claim per patch");
    assert.deepEqual([k1.documents[0].id, k1.documents[0].url], [k1.sources[0].textHash, PUBG_NEWS_URL], "the evidence is the response that was fetched");
    const claim = k1.claims.find(c => c.eventKey === "pubg/last-patch/43.1")!;
    assert.deepEqual([claim.value, claim.method, claim.linkUrl, claim.documentId], [LATEST.at, "deterministic", LATEST.url, k1.documents[0].id]);
    assert.ok(FEED.includes(claim.quote!), "the quote is copied from the fetched response");
    assert.equal(JSON.parse(claim.quote!).date, 1788933617);
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
    assert.deepEqual(second.work, { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 });
    const k2 = store.load("pubg");
    assert.deepEqual([k2.documents, k2.claims], [k1.documents, k1.claims], "idempotent");
    assert.equal(model.requests.length, 0);
    assert.equal(ledger.calls("2026-09-16").length, 0);
});

test("a feed that changes for other posts adds no evidence copies; a new patch adds one claim", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createPubgPatchAdapter(fakeTransport({ http: [{ body: FEED }] })), store, NOW);
    const withEsports = JSON.parse(FEED);
    withEsports.appnews.newsitems.unshift(item({ gid: "1845000000000009", title: "PUBG Global Championship: Finals Day 1 is LIVE!!", date: 1789000000 }));
    const esports = await runTracker(game, topic, createPubgPatchAdapter(fakeTransport({ http: [{ body: JSON.stringify(withEsports) }] })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(esports.result.status, "fresh");
    assert.deepEqual([store.load("pubg").documents.length, store.load("pubg").claims.length], [1, 4]);

    withEsports.appnews.newsitems.unshift(item({}));
    const patch = await runTracker(game, topic, createPubgPatchAdapter(fakeTransport({ http: [{ body: JSON.stringify(withEsports) }] })), store, new Date("2026-10-06T12:00:00Z"));
    assert.equal((patch.result as any).nextEventUtc, new Date(1791525600 * 1000).toISOString());
    assert.equal((patch.result as any).source_url, item({}).url);
    assert.deepEqual([patch.created, store.load("pubg").documents.length, store.load("pubg").claims.length], [1, 2, 5]);
});

test("a response without any patch notes post keeps the last patch published as stale, and is examined again next run", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createPubgPatchAdapter(fakeTransport({ http: [{ body: FEED }] })), store, NOW);
    const goodHash = store.load("pubg").sources[0].textHash;
    const esportsOnly = feedWith([item({ gid: "1", title: "PUBG Americas Series 2: Playoffs 2 Day 1 is LIVE!!" })]);
    for (const at of ["2026-09-16T06:00:00Z", "2026-09-16T12:00:00Z"]) {
        const run = await runTracker(game, topic, createPubgPatchAdapter(fakeTransport({ http: [{ body: esportsOnly }] })), store, new Date(at));
        assert.equal(run.result.status, "stale");
        assert.equal((run.result as any).reason_code, "no-new-information");
        assert.match(run.failureDetail ?? "", /no "Patch Notes - Update" post/);
        assert.equal((run.result as any).nextEventUtc, LATEST.at);
    }
    const state = store.load("pubg").sources[0];
    assert.deepEqual([state.lastVerdict, state.textHash, state.consecutiveFailures], ["no-update-posts", goodHash, 2]);
});

test("a re-post after the original left the feed keeps the stored first publication and adds no evidence", async () => {
    const { store } = tempStore();
    const firstPublished = new Date(1791525600 * 1000).toISOString();
    await runTracker(game, topic, createPubgPatchAdapter(fakeTransport({ http: [{ body: feedWith([item({ gid: "7", date: 1791525600 })]) }] })), store, new Date("2026-10-09T12:00:00Z"));

    const repostOnly = feedWith([item({ gid: "8", date: 1791612000, contents: "Re-posted with a corrected image." })]);
    const run = await runTracker(game, topic, createPubgPatchAdapter(fakeTransport({ http: [{ body: repostOnly }] })), store, new Date("2026-10-10T12:00:00Z"));
    assert.equal(run.result.status, "fresh");
    assert.equal((run.result as any).nextEventUtc, firstPublished, "the first publication stands");
    assert.deepEqual([run.created, run.changes.length], [0, 0]);
    const k = store.load("pubg");
    assert.equal(k.events.find(e => e.key === "pubg/last-patch/44.1")!.at, firstPublished);
    assert.deepEqual([k.documents.length, k.claims.length], [1, 1], "the re-post adds no evidence");
});

test("the production registry runs PUBG on the Steam news adapter", () => {
    assert.equal(game.sources[0].url, PUBG_NEWS_URL);
    assert.equal(topic.view.sourceUrl, PUBG_PATCH_NOTES_PAGE);
    assert.equal(topic.discovery, undefined, "a structured source needs no discovery");
    assert.equal(typeof adapterFor(topic), "function");
});
