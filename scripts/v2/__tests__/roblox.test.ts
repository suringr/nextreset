import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { createRobloxStatusAdapter, parseHostedStatus } from "../adapters/roblox";
import { findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { fakeTransport } from "./fake-transport";
import fixture from "./fixtures/roblox-hostedstatus.json";
import { V1_ROBLOX_FRESH_KEYS, V1_UNAVAILABLE_KEYS, tempStore } from "./helpers";

const game = findGame("roblox");
const topic = findTopic(game, "status");
const FEED_URL = "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d";

function feedTransport(body: unknown, headers: Record<string, string> = {}) {
    return fakeTransport({ http: [{ body: JSON.stringify(body), headers }] });
}

function withOverall(overall: Record<string, unknown>): unknown {
    const copy = JSON.parse(JSON.stringify(fixture));
    copy.result.status_overall = { ...copy.result.status_overall, ...overall };
    return copy;
}

test("deterministic parse of the saved fixture", () => {
    const snapshot = parseHostedStatus(JSON.stringify(fixture));
    assert.deepEqual(snapshot, { status: "Operational", updated: "2026-08-07T04:48:28.252Z", statusCode: 100 });
    assert.deepEqual(parseHostedStatus(JSON.stringify(fixture)), snapshot);
});

test("parse rejects malformed feeds and accepts epoch seconds", () => {
    assert.throws(() => parseHostedStatus("not json"), /Invalid JSON/);
    assert.throws(() => parseHostedStatus(JSON.stringify({ result: {} })), /status_overall/);
    assert.throws(() => parseHostedStatus(JSON.stringify(withOverall({ updated: "" }))), /No updated timestamp/);
    assert.throws(() => parseHostedStatus(JSON.stringify(withOverall({ updated: "yesterday" }))), /Invalid date format/);
    const epochSeconds = Math.floor(Date.UTC(2026, 7, 7, 4, 48, 28) / 1000);
    assert.equal(parseHostedStatus(JSON.stringify(withOverall({ updated: epochSeconds }))).updated, "2026-08-07T04:48:28.000Z");
    assert.equal(parseHostedStatus(JSON.stringify(withOverall({ status: "  " }))).status, "unknown");
});

test("unchanged source data produces no fake change on the second run and is detected by text hash", async () => {
    const { store } = tempStore();
    const transport = feedTransport(fixture, { "etag": "\"feed-v1\"" });
    const adapter = createRobloxStatusAdapter(transport);

    const first = await runTracker(game, topic, adapter, store, new Date("2026-09-14T12:00:00Z"));
    assert.equal(first.created, 1);
    assert.equal(first.changes.length, 1);
    assert.equal(first.changes[0].newValue, "Operational @ 2026-08-07T04:48:28.252Z");
    assert.equal(transport.gets[0].url, FEED_URL);
    assert.equal(transport.gets[0].etag, undefined);

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-14T18:00:00Z"));
    assert.equal(second.created, 0);
    assert.equal(second.changes.length, 0);
    assert.equal(transport.gets[1].etag, "\"feed-v1\"", "the persisted ETag is sent on the next run");

    const knowledge = store.load("roblox");
    assert.equal(knowledge.events.length, 1);
    assert.equal(knowledge.changes.length, 1);
    assert.equal(knowledge.events[0].key, "roblox/status/2026-08-07t04-48-28z");
    assert.equal(knowledge.events[0].lastVerified, "2026-09-14T18:00:00.000Z");
    assert.equal(knowledge.sources.length, 1);
    assert.equal(knowledge.sources[0].id, "roblox-hostedstatus");
    assert.equal(knowledge.sources[0].etag, "\"feed-v1\"");
    assert.equal(knowledge.sources[0].textHash!.length, 64);
    assert.equal(knowledge.sources[0].consecutiveFailures, 0);
    assert.equal(second.result.status, "fresh");
});

test("an HTTP 304 re-verifies the current event without parsing anything", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(fixture, { "etag": "\"feed-v1\"" })), store, new Date("2026-09-14T12:00:00Z"));

    const notModified = fakeTransport({ http: [{ status: 304, notModified: true }] });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(notModified), store, new Date("2026-09-14T18:00:00Z"));
    assert.equal(run.changes.length, 0);
    assert.equal(run.result.status, "fresh");
    assert.equal((run.result as any).http_status, 304);
    assert.equal((run.result as any).nextEventUtc, "2026-08-07T04:48:28.252Z");
    const knowledge = store.load("roblox");
    assert.equal(knowledge.events[0].lastVerified, "2026-09-14T18:00:00.000Z");
    assert.equal(knowledge.sources[0].lastFetchedAt, "2026-09-14T18:00:00.000Z");
});

test("changed source data produces a Change and keeps the previous event", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(fixture)), store, new Date("2026-09-14T12:00:00Z"));

    const changed = withOverall({ updated: "2026-09-14T15:30:00.000Z", status: "Degraded Performance", status_code: 300 });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(changed)), store, new Date("2026-09-14T18:00:00Z"));

    assert.equal(run.created, 1);
    assert.deepEqual(run.changes.map(c => [c.entityKey, c.field, c.oldValue, c.newValue]), [
        ["roblox/status/2026-09-14t15-30-00z", "event", null, "Degraded Performance @ 2026-09-14T15:30:00.000Z"]
    ]);

    const knowledge = store.load("roblox");
    assert.equal(knowledge.events.length, 2);
    assert.equal(knowledge.changes.length, 2);
    const fresh = run.result as any;
    assert.equal(fresh.nextEventUtc, "2026-09-14T15:30:00.000Z");
    assert.equal(fresh.notes, "Current status: Degraded Performance");
});

test("compatibility JSON matches the V1 contract", async () => {
    const { store } = tempStore();
    const now = new Date("2026-09-14T12:00:00Z");
    const { result } = await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(fixture)), store, now);

    assert.deepEqual(Object.keys(result), V1_ROBLOX_FRESH_KEYS);
    const fresh = result as any;
    assert.equal(fresh.provider_id, "roblox");
    assert.equal(fresh.type, "status");
    assert.equal(fresh.title, "Roblox Service Status");
    assert.equal(fresh.status, "fresh");
    assert.equal(fresh.nextEventUtc, "2026-08-07T04:48:28.252Z");
    assert.equal(fresh.fetched_at_utc, now.toISOString());
    assert.equal(fresh.last_success_at_utc, now.toISOString());
    assert.equal(fresh.source_url, "https://status.roblox.com");
    assert.equal(fresh.confidence, "high");
    assert.equal(fresh.http_status, 200);
    assert.equal(fresh.fetch_mode, "http");
    assert.equal(fresh.notes, "Current status: Operational");
});

test("fetch failure serves stored knowledge as stale and records the failure streak", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(fixture)), store, new Date("2026-09-14T12:00:00Z"));
    const failing = fakeTransport({ http: [{ status: 503, body: "<html><body>Service unavailable</body></html>" }] });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(failing), store, new Date("2026-09-14T18:00:00Z"));

    assert.equal(run.changes.length, 0);
    const stale = run.result as any;
    assert.equal(stale.status, "stale");
    assert.equal(stale.nextEventUtc, "2026-08-07T04:48:28.252Z");
    assert.equal(stale.fetched_at_utc, "2026-09-14T18:00:00.000Z");
    assert.equal(stale.last_success_at_utc, "2026-09-14T12:00:00.000Z");
    assert.equal(stale.reason, "HTTP 503");
    assert.equal(stale.notes, "Current status: Operational");
    assert.ok(Object.keys(stale).includes("reason"));
    assert.ok(!Object.keys(stale).includes("http_status"));

    const knowledge = store.load("roblox");
    assert.equal(knowledge.sources[0].consecutiveFailures, 1);
    assert.equal(knowledge.sources[0].lastVerdict, "http-error");
    assert.equal(knowledge.sources[0].textHash!.length, 64, "last good hash survives a failure");
});

test("valid JSON with the wrong shape is recorded as a source failure and served stale", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(fixture)), store, new Date("2026-09-14T12:00:00Z"));
    const before = store.load("roblox").sources[0];

    const wrongShape = feedTransport({ result: { status: [] } }, { "etag": "\"bad-shape\"" });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(wrongShape), store, new Date("2026-09-14T18:00:00Z"));
    assert.equal(run.result.status, "stale");
    assert.match((run.result as any).reason, /status_overall/);
    assert.equal(run.changes.length, 0);

    const after = store.load("roblox").sources[0];
    assert.equal(after.consecutiveFailures, 1);
    assert.equal(after.lastVerdict, "parse-error");
    assert.equal(after.lastFetchedAt, "2026-09-14T18:00:00.000Z");
    assert.equal(after.textHash, before.textHash, "the last good hash is kept");
    assert.equal(after.lastUsableAt, before.lastUsableAt);
    assert.equal(after.etag, undefined, "validators of bad content are not kept, so the next run cannot 304 into a false 'unchanged'");

    // A second bad response keeps counting.
    const again = await runTracker(game, topic, createRobloxStatusAdapter(wrongShape), store, new Date("2026-09-15T00:00:00Z"));
    assert.equal(again.result.status, "stale");
    assert.equal(store.load("roblox").sources[0].consecutiveFailures, 2);
});

test("a 200 that is not JSON is a failure, not data", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(fixture)), store, new Date("2026-09-14T12:00:00Z"));
    const shell = fakeTransport({ http: [{ status: 200, body: "<html><body>Just a moment...</body></html>" }] });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(shell), store, new Date("2026-09-14T18:00:00Z"));
    assert.equal(run.result.status, "stale");
    assert.match((run.result as any).reason, /bot-challenge/);
});

test("fetch failure with no stored knowledge is unavailable", async () => {
    const { store } = tempStore();
    const failing = fakeTransport({ http: [{ status: 503, body: "" }] });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(failing), store, new Date("2026-09-14T12:00:00Z"));
    assert.deepEqual(Object.keys(run.result), V1_UNAVAILABLE_KEYS);
    const unavailable = run.result as any;
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.nextEventUtc, null);
    assert.equal(unavailable.failure_type, "unavailable");
    assert.match(unavailable.explanation, /empty body \(HTTP 503\)/);
    // The failure streak is still recorded.
    assert.equal(store.load("roblox").sources[0].consecutiveFailures, 1);
});

test("a corrupt knowledge file makes the tracker unavailable and is left untouched", async () => {
    const { store } = tempStore();
    const file = store.filePath("roblox");
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ broken", "utf8");

    const run = await runTracker(game, topic, createRobloxStatusAdapter(feedTransport(fixture)), store, new Date("2026-09-14T12:00:00Z"));
    assert.equal(run.result.status, "unavailable");
    assert.match((run.result as any).explanation, /Knowledge store error: .*not valid JSON/);
    assert.equal(run.knowledge, null);
    assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
});
