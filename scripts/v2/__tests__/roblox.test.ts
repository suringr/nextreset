import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { FetchedText, createRobloxStatusAdapter, parseHostedStatus } from "../adapters/roblox";
import { findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import fixture from "./fixtures/roblox-hostedstatus.json";
import { V1_ROBLOX_FRESH_KEYS, V1_UNAVAILABLE_KEYS, tempStore } from "./helpers";

const game = findGame("roblox");
const topic = findTopic(game, "status");
const FEED_URL = "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d";

function fetcherReturning(body: unknown): (url: string) => Promise<FetchedText> {
    return async (url) => {
        assert.equal(url, FEED_URL);
        return { ok: true, status: 200, text: JSON.stringify(body), mode: "http" };
    };
}

const failingFetcher = async (): Promise<FetchedText> => ({ ok: false, status: 503, text: "", mode: "http", error: "HTTP 503" });

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

test("unchanged source data produces no fake change on the second run", async () => {
    const { store } = tempStore();
    const adapter = createRobloxStatusAdapter(fetcherReturning(fixture));

    const first = await runTracker(game, topic, adapter, store, new Date("2026-09-14T12:00:00Z"));
    assert.equal(first.created, 1);
    assert.equal(first.changes.length, 1);
    assert.equal(first.changes[0].newValue, "Operational @ 2026-08-07T04:48:28.252Z");

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-14T18:00:00Z"));
    assert.equal(second.created, 0);
    assert.equal(second.changes.length, 0);

    const knowledge = store.load("roblox");
    assert.equal(knowledge.events.length, 1);
    assert.equal(knowledge.changes.length, 1);
    assert.equal(knowledge.events[0].key, "roblox/status/2026-08-07t04-48-28z");
    assert.equal(knowledge.events[0].lastVerified, "2026-09-14T18:00:00.000Z");
});

test("changed source data produces a Change and keeps the previous event", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createRobloxStatusAdapter(fetcherReturning(fixture)), store, new Date("2026-09-14T12:00:00Z"));

    const changed = withOverall({ updated: "2026-09-14T15:30:00.000Z", status: "Degraded Performance", status_code: 300 });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(fetcherReturning(changed)), store, new Date("2026-09-14T18:00:00Z"));

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
    const { result } = await runTracker(game, topic, createRobloxStatusAdapter(fetcherReturning(fixture)), store, now);

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

test("fetch failure serves stored knowledge as stale", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createRobloxStatusAdapter(fetcherReturning(fixture)), store, new Date("2026-09-14T12:00:00Z"));
    const run = await runTracker(game, topic, createRobloxStatusAdapter(failingFetcher), store, new Date("2026-09-14T18:00:00Z"));

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
});

test("fetch failure with no stored knowledge is unavailable", async () => {
    const { store } = tempStore();
    const run = await runTracker(game, topic, createRobloxStatusAdapter(failingFetcher), store, new Date("2026-09-14T12:00:00Z"));
    assert.deepEqual(Object.keys(run.result), V1_UNAVAILABLE_KEYS);
    const unavailable = run.result as any;
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.nextEventUtc, null);
    assert.equal(unavailable.failure_type, "unavailable");
    assert.equal(unavailable.explanation, "HTTP 503");
    assert.equal(fs.existsSync(store.filePath("roblox")), false);
});

test("a corrupt knowledge file makes the tracker unavailable and is left untouched", async () => {
    const { store } = tempStore();
    const file = store.filePath("roblox");
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ broken", "utf8");

    const run = await runTracker(game, topic, createRobloxStatusAdapter(fetcherReturning(fixture)), store, new Date("2026-09-14T12:00:00Z"));
    assert.equal(run.result.status, "unavailable");
    assert.match((run.result as any).explanation, /Knowledge store error: .*not valid JSON/);
    assert.equal(run.knowledge, null);
    assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
});
