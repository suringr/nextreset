/**
 * Counter-Strike 2 on V2: Steam news API (structured JSON) -> deterministic parse ->
 * events with document + claim evidence -> KnowledgeStore -> V1-compatible view.
 * The fixture is a real, filtered response captured on 2026-09-16.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CS2_NEWS_URL, CS2_UPDATES_PAGE, createCs2UpdatesAdapter, parseSteamUpdates } from "../adapters/cs2";
import { MockAiProvider } from "../ai/mock";
import { DEFAULT_AI_BUDGET_LIMITS, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fakeTransport, fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";

const game = findGame("cs2");
const topic = findTopic(game, "last-update");
const FEED = fixture("steam-cs2-news-api.json");
const LATEST = { gid: "1843481262690556", at: "2026-09-09T22:51:08.000Z", url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1843481262690556" };
const NOW = new Date("2026-09-16T00:00:00Z");

type Item = Record<string, unknown>;
const item = (overrides: Item): Item => ({
    gid: "1844000000000001", title: "Counter-Strike 2 Update", url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1844000000000001",
    is_external_url: true, author: "tomd", contents: "[p]Release notes[/p]", feedlabel: "Community Announcements", date: 1789500000,
    feedname: "steam_community_announcements", feed_type: 1, appid: 730, tags: ["patchnotes"], ...overrides
});
const feedWith = (items: Item[]) => JSON.stringify({ appnews: { appid: 730, newsitems: items, count: items.length } });
const withNewer = (newer: Item) => { const d = JSON.parse(FEED); d.appnews.newsitems.unshift(newer); return JSON.stringify(d); };

/** A budget gate whose model must never be called: CS2 is structured data. */
function noModelGate(ledger: AiUsageLedger) {
    const model = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("Steam news must never reach the model"); });
    return { model, gate: createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "cs2-test", model: model.model, loadProvider: async () => model, env: {} }) };
}

test("only Valve's live update posts are parsed, newest first, at their exact publication time", () => {
    const posts = parseSteamUpdates(FEED);
    assert.equal(posts.length, 19, "the armory post tagged as patch notes is not an update");
    assert.deepEqual({ gid: posts[0].gid, at: posts[0].at, url: posts[0].url }, LATEST);
    assert.ok(posts.every(p => p.title === "Counter-Strike 2 Update"));
    assert.ok(posts.every((p, i) => i === 0 || posts[i - 1].date >= p.date), "newest first");
    assert.ok(!posts.some(p => p.gid === "1838407329258098"), "Call II Arms-ory is ignored");
});

test("beta, pre-release, press, untagged and malformed posts are ignored, and a wrong shape throws", () => {
    const posts = parseSteamUpdates(feedWith([
        item({ gid: "1", title: "Animgraph 2 Beta Update" }),
        item({ gid: "2", title: "Counter-Strike 2 Pre-Release Update" }),
        item({ gid: "3", feedname: "PC Gamer", feed_type: 0 }),
        item({ gid: "4", tags: [] }),
        item({ gid: "not-a-gid" }),
        item({ gid: "6", date: "yesterday" }),
        item({ gid: "7", url: "javascript:alert(1)" }),
        item({ gid: "8", title: "  counter-strike 2 update " })
    ]));
    assert.deepEqual(posts.map(p => [p.gid, p.url, p.title]), [["7", CS2_UPDATES_PAGE, "Counter-Strike 2 Update"], ["8", String(item({}).url), "counter-strike 2 update"]].sort((a, b) => (a[0] < b[0] ? 1 : -1)));
    assert.throws(() => parseSteamUpdates("<html>challenge</html>"), /Invalid JSON/);
    assert.throws(() => parseSteamUpdates("{}"), /No appnews.newsitems/);
});

test("the first run publishes the latest update with its exact time and a link to the post; an unchanged run changes nothing and makes no model call", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { model, gate } = noModelGate(ledger);
    const transport = fakeTransport({ http: [{ body: FEED, headers: { "content-type": "application/json; charset=UTF-8" } }] });
    const adapter = createCs2UpdatesAdapter(transport);

    const first = await runTracker(game, topic, adapter, store, NOW, { ai: gate });
    assert.equal(transport.gets[0].url, CS2_NEWS_URL);
    assert.equal(first.result.status, "fresh");
    const fresh = first.result as Extract<typeof first.result, { status: "fresh" }>;
    assert.deepEqual(Object.keys(fresh), [...V1_ROBLOX_FRESH_KEYS, "precision"]);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["cs2", "cs2", "last-update", "Counter-Strike 2 Last Update"], "same data file and page as V1");
    assert.equal(fresh.nextEventUtc, LATEST.at, "the exact post time, not midnight of the day");
    assert.equal(fresh.notes, "Counter-Strike 2 Update");
    assert.equal(fresh.source_url, LATEST.url, "links to the update post itself");
    assert.equal(fresh.confidence, "high");
    assert.equal(fresh.fetch_mode, "http");
    assert.equal(fresh.http_status, 200);
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });
    assert.equal(first.created, 19);

    const k1 = store.load("cs2");
    assert.equal(k1.events.length, 19);
    assert.ok(k1.events.every(e => e.status === "observed" && e.precision === "exact" && e.timezone === "UTC" && e.kind === "occurrence"));
    assert.ok(k1.events.some(e => e.key === `cs2/last-update/${LATEST.gid}`));
    assert.equal(k1.documents.length, 1, "one document: the response that was fetched");
    assert.equal(k1.claims.length, 19);
    const claim = k1.claims.find(c => c.eventKey === `cs2/last-update/${LATEST.gid}`)!;
    assert.deepEqual([claim.field, claim.value, claim.method], ["at", LATEST.at, "deterministic"]);
    assert.ok(FEED.includes(claim.quote!), "the claim quotes the post exactly as fetched");
    assert.equal(JSON.parse(claim.quote!).date, 1788994268);
    assert.equal(claim.linkUrl, LATEST.url, "the claim carries the post link visitors get");
    assert.deepEqual([k1.documents[0].id, k1.documents[0].url], [k1.sources[0].textHash, CS2_NEWS_URL], "the evidence is the response that was fetched");
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.equal((second.result as any).nextEventUtc, LATEST.at);
    assert.equal((second.result as any).source_url, LATEST.url);
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
    assert.deepEqual(second.work, { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 });
    const k2 = store.load("cs2");
    assert.deepEqual([k2.events.length, k2.documents.length, k2.claims.length, k2.changes.length], [19, 1, 19, 19], "idempotent: nothing duplicated");
    assert.deepEqual(k2.documents, k1.documents);
    assert.deepEqual(k2.claims, k1.claims);
    assert.equal(k2.events.find(e => e.key === `cs2/last-update/${LATEST.gid}`)?.lastVerified, "2026-09-16T06:00:00.000Z");

    assert.equal(model.requests.length, 0);
    assert.equal(ledger.calls("2026-09-16").length, 0);
    assert.deepEqual(k2.topicStates, []);
});

test("a new update post is added without rewriting the history", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [{ body: FEED }] })), store, NOW);
    const newer = item({});
    const run = await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [{ body: withNewer(newer) }] })), store, new Date("2026-09-17T00:00:00Z"));
    assert.equal(run.result.status, "fresh");
    assert.equal((run.result as any).nextEventUtc, new Date(1789500000 * 1000).toISOString());
    assert.equal((run.result as any).source_url, newer.url);
    assert.deepEqual([run.created, run.changes.length], [1, 1]);
    const k = store.load("cs2");
    assert.deepEqual([k.events.length, k.documents.length, k.claims.length], [20, 2, 20], "only the new post adds evidence");
});

test("no update post, a wrong shape or a challenge page keeps the last update published as stale, and is examined again next run", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [{ body: FEED }] })), store, NOW);
    const goodHash = store.load("cs2").sources[0].textHash;

    const armoryOnly = feedWith([item({ gid: "1838407329258098", title: "Call II Arms-ory" })]);
    for (const at of ["2026-09-16T06:00:00Z", "2026-09-16T12:00:00Z"]) {
        const run = await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [{ body: armoryOnly }] })), store, new Date(at));
        assert.equal(run.result.status, "stale", `still stale at ${at}: the same suspicious content is not accepted as unchanged`);
        assert.equal((run.result as any).reason_code, "no-new-information");
        assert.match(run.failureDetail ?? "", /no "Counter-Strike 2 Update" post/);
        assert.equal((run.result as any).nextEventUtc, LATEST.at);
    }
    let state = store.load("cs2").sources[0];
    assert.deepEqual([state.lastVerdict, state.textHash, state.consecutiveFailures], ["no-update-posts", goodHash, 2]);

    const wrongShape = await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [{ body: "{\"response\":{}}" }] })), store, new Date("2026-09-16T18:00:00Z"));
    assert.equal(wrongShape.result.status, "stale");
    assert.equal((wrongShape.result as any).reason_code, "extraction-failed");
    assert.match(wrongShape.failureDetail ?? "", /No appnews.newsitems/);
    state = store.load("cs2").sources[0];
    assert.deepEqual([state.lastVerdict, state.textHash], ["parse-error", goodHash]);

    const challenge = await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [{ body: "<html><body>Access denied</body></html>", headers: { "content-type": "text/html" } }] })), store, new Date("2026-09-17T00:00:00Z"));
    assert.equal(challenge.result.status, "stale");
    assert.equal((challenge.result as any).nextEventUtc, LATEST.at);

    const recovered = await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [{ body: FEED }] })), store, new Date("2026-09-17T06:00:00Z"));
    assert.equal(recovered.result.status, "fresh");
    assert.equal(store.load("cs2").events.length, 19, "nothing was lost or duplicated along the way");
});

test("the production registry runs CS2 on the V2 adapter against the Steam news API", () => {
    assert.equal(game.sources[0].url, CS2_NEWS_URL);
    assert.equal(topic.view.sourceUrl, CS2_UPDATES_PAGE);
    assert.equal(topic.discovery, undefined, "a structured source needs no discovery");
    assert.equal(typeof adapterFor(topic), "function");
});
