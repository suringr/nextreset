/**
 * Minecraft: Java Edition on V2: Mojang version manifest (structured JSON) -> deterministic parse ->
 * latest release event with document + claim evidence -> KnowledgeStore -> V1-compatible view.
 * `mojang-version-manifest-2026-09-15.json` is a trimmed live capture (26.3 released that day).
 * The earlier manifest is derived from it: the day before 26.3, release candidates listed ahead of 26.2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MINECRAFT_CHANGELOGS_PAGE, MINECRAFT_MANIFEST_URL, createMinecraftJavaAdapter, parseLatestJavaRelease } from "../adapters/minecraft-java";
import { MockAiProvider } from "../ai/mock";
import { DEFAULT_AI_BUDGET_LIMITS, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fakeTransport, fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";

const game = findGame("minecraft");
const topic = findTopic(game, "last-release");
const CURRENT = fixture("mojang-version-manifest-2026-09-15.json");
const NOW = new Date("2026-09-16T00:00:00Z");

const manifest = (text: string) => JSON.parse(text) as { latest: { release: string; snapshot: string }; versions: Array<Record<string, string>> };
const edit = (text: string, change: (m: ReturnType<typeof manifest>) => void) => { const m = manifest(text); change(m); return JSON.stringify(m); };
/** The manifest the day before 26.3: its release candidates listed, latest.release still 26.2 at 26.2's real releaseTime. */
const EARLIER = edit(CURRENT, m => {
    m.versions = m.versions.filter(v => v.id !== "26.3");
    m.latest = { release: "26.2", snapshot: "26.3-rc-3" };
    m.versions.push({ id: "26.2", type: "release", url: "https://piston-meta.mojang.com/v1/packages/0000/26.2.json", time: "2026-06-16T12:05:00+00:00", releaseTime: "2026-06-16T12:03:33+00:00" });
});

function noModelGate(ledger: AiUsageLedger) {
    const model = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("the Mojang manifest must never reach the model"); });
    return { model, gate: createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "minecraft-test", model: model.model, loadProvider: async () => model, env: {} }) };
}

test("the latest release is read from latest.release at its exact releaseTime, never a snapshot", () => {
    const current = parseLatestJavaRelease(CURRENT);
    assert.deepEqual([current.id, current.at, current.releaseTime], ["26.3", "2026-09-15T11:23:02.000Z", "2026-09-15T11:23:02+00:00"]);
    assert.match(current.url, /^https:\/\/piston-meta\.mojang\.com\//);

    const earlier = manifest(EARLIER);
    assert.notEqual(earlier.latest.snapshot, earlier.latest.release, "this capture has a snapshot ahead of the release");
    const release = parseLatestJavaRelease(EARLIER);
    assert.equal(release.id, earlier.latest.release);
    assert.equal(release.at, new Date(earlier.versions.find(v => v.id === earlier.latest.release)!.releaseTime).toISOString());
});

test("a manifest that cannot vouch for a release is rejected", () => {
    assert.throws(() => parseLatestJavaRelease("<html>maintenance</html>"), /Invalid JSON/);
    assert.throws(() => parseLatestJavaRelease(edit(CURRENT, m => { (m.latest as any).release = ""; })), /No latest.release/);
    assert.throws(() => parseLatestJavaRelease(edit(CURRENT, m => { m.latest.release = "99.9"; })), /has no entry/);
    assert.throws(() => parseLatestJavaRelease(edit(CURRENT, m => { m.latest.release = "26.3-rc-3"; })), /not a release/);
    assert.throws(() => parseLatestJavaRelease(edit(CURRENT, m => { m.versions[0].releaseTime = "soon"; })), /Invalid releaseTime/);
});

test("the first run publishes the release at its exact time on the existing page; an unchanged run changes nothing and makes no model call", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { model, gate } = noModelGate(ledger);
    const transport = fakeTransport({ http: [{ body: CURRENT, headers: { "content-type": "application/json" } }] });
    const adapter = createMinecraftJavaAdapter(transport);

    const first = await runTracker(game, topic, adapter, store, NOW, { ai: gate });
    assert.equal(transport.gets[0].url, MINECRAFT_MANIFEST_URL);
    assert.equal(first.result.status, "fresh");
    const fresh = first.result as Extract<typeof first.result, { status: "fresh" }>;
    assert.deepEqual(Object.keys(fresh), V1_ROBLOX_FRESH_KEYS);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["minecraft", "minecraft", "last-release", "Minecraft Last Release"], "same data file and page as V1");
    assert.equal(fresh.nextEventUtc, "2026-09-15T11:23:02.000Z");
    assert.equal(fresh.notes, "Java Edition 26.3");
    assert.equal(fresh.source_url, MINECRAFT_CHANGELOGS_PAGE, "visitors get the changelogs page, not the manifest JSON");
    assert.deepEqual([fresh.confidence, fresh.fetch_mode, fresh.http_status], ["high", "http", 200]);
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });

    const k1 = store.load("minecraft");
    assert.deepEqual(k1.events.map(e => [e.key, e.kind, e.status, e.at, e.precision, e.timezone]), [["minecraft/last-release/26.3", "version", "observed", "2026-09-15T11:23:02.000Z", "exact", "UTC"]]);
    assert.equal(k1.documents.length, 1);
    assert.match(k1.documents[0].url, /^https:\/\/piston-meta\.mojang\.com\//, "the evidence records where the instant came from");
    assert.deepEqual(k1.claims.map(c => [c.field, c.value, c.method, c.quote]), [["at", "2026-09-15T11:23:02.000Z", "deterministic", JSON.stringify({ id: "26.3", type: "release", releaseTime: "2026-09-15T11:23:02+00:00" })]]);
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
    assert.deepEqual(second.work, { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 });
    const k2 = store.load("minecraft");
    assert.deepEqual([k2.events.length, k2.documents.length, k2.claims.length, k2.changes.length], [1, 1, 1, 1], "idempotent");
    assert.equal(model.requests.length, 0);
    assert.equal(ledger.calls("2026-09-16").length, 0);
});

test("a new release is added, and a manifest that only gains snapshots changes nothing", async () => {
    const { store } = tempStore();
    const earlierRelease = manifest(EARLIER).latest.release;
    await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: EARLIER }] })), store, new Date("2026-09-14T00:00:00Z"));
    assert.equal(store.load("minecraft").events[0].label, earlierRelease);

    const released = await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: CURRENT }] })), store, NOW);
    assert.equal((released.result as any).nextEventUtc, "2026-09-15T11:23:02.000Z");
    assert.equal(released.created, 1);
    assert.deepEqual(store.load("minecraft").events.map(e => e.label).sort(), [earlierRelease, "26.3"].sort());

    const snapshotOnly = edit(CURRENT, m => {
        m.latest.snapshot = "26.4-snapshot-1";
        m.versions.unshift({ id: "26.4-snapshot-1", type: "snapshot", url: "https://piston-meta.mojang.com/v1/packages/x/26.4-snapshot-1.json", time: "2026-09-20T10:00:00+00:00", releaseTime: "2026-09-20T10:00:00+00:00" });
    });
    const snapshot = await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: snapshotOnly }] })), store, new Date("2026-09-20T12:00:00Z"));
    assert.equal(snapshot.result.status, "fresh");
    assert.equal((snapshot.result as any).nextEventUtc, "2026-09-15T11:23:02.000Z", "a snapshot is not a release");
    assert.deepEqual([snapshot.created, snapshot.changes.length], [0, 0]);
});

test("a manifest that cannot vouch for a release keeps the last release published as stale and is examined again next run", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: CURRENT }] })), store, NOW);
    const goodHash = store.load("minecraft").sources[0].textHash;

    const dangling = edit(CURRENT, m => { m.latest.release = "26.4"; });
    for (const at of ["2026-09-16T06:00:00Z", "2026-09-16T12:00:00Z"]) {
        const run = await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: dangling }] })), store, new Date(at));
        assert.equal(run.result.status, "stale");
        assert.match((run.result as any).reason, /has no entry/);
        assert.equal((run.result as any).nextEventUtc, "2026-09-15T11:23:02.000Z");
    }
    const state = store.load("minecraft").sources[0];
    assert.deepEqual([state.lastVerdict, state.textHash, state.consecutiveFailures], ["parse-error", goodHash, 2]);

    const recovered = await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: CURRENT }] })), store, new Date("2026-09-17T00:00:00Z"));
    assert.equal(recovered.result.status, "fresh");
});

test("when the manifest rolls latest.release back, the withdrawn release is held, and published again only if it returns", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: CURRENT }] })), store, NOW);

    const rolledBack = await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: EARLIER }] })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(rolledBack.result.status, "fresh");
    assert.equal((rolledBack.result as any).nextEventUtc, "2026-06-16T12:03:33.000Z", "the manifest's current release is published");
    assert.equal((rolledBack.result as any).notes, "Java Edition 26.2");
    assert.equal(store.load("minecraft").events.find(e => e.label === "26.3")!.publishState, "held");
    assert.ok(rolledBack.changes.some(c => c.entityKey === "minecraft/last-release/26.3" && c.field === "publishState" && c.newValue === "held" && c.decision === "held"));
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(store.load("minecraft")))));

    const restored = await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: CURRENT }] })), store, new Date("2026-09-16T12:00:00Z"));
    assert.equal((restored.result as any).nextEventUtc, "2026-09-15T11:23:02.000Z");
    assert.equal(store.load("minecraft").events.find(e => e.label === "26.3")!.publishState, "published");
    assert.ok(restored.changes.some(c => c.entityKey === "minecraft/last-release/26.3" && c.field === "publishState" && c.newValue === "published"));
    assert.equal(store.load("minecraft").events.find(e => e.label === "26.2")!.publishState, "published", "an older release is never held by a newer pointer");
});

test("the production registry runs Minecraft on the Java manifest adapter with the changelogs page as its link", () => {
    assert.equal(game.sources[0].url, MINECRAFT_MANIFEST_URL);
    assert.equal(topic.view.sourceUrl, MINECRAFT_CHANGELOGS_PAGE);
    assert.equal(topic.view.linkEvidence, false);
    assert.equal(topic.discovery, undefined, "a structured source needs no discovery");
    assert.equal(typeof adapterFor(topic), "function");
});
