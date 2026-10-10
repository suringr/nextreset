/**
 * Minecraft: Java Edition on V2: Mojang version manifest (structured JSON) -> deterministic parse ->
 * latest release event with document + claim evidence -> KnowledgeStore -> V1-compatible view.
 * `mojang-version-manifest-2026-09-15.json` is a trimmed live capture (26.3 released that day).
 * The earlier manifest is derived from it: the day before 26.3, release candidates listed ahead of 26.2.
 */
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { KEPT_RELEASES, MINECRAFT_CHANGELOGS_PAGE, MINECRAFT_MANIFEST_URL, createMinecraftJavaAdapter, parseLatestJavaRelease, parseRecentJavaReleases } from "../adapters/minecraft-java";
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
    assert.ok(CURRENT.includes(current.excerpt), "the excerpt is a verbatim slice of the manifest");
    assert.deepEqual(JSON.parse(current.excerpt), manifest(CURRENT).versions.find(v => v.id === "26.3"));

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
    assert.deepEqual(Object.keys(fresh), [...V1_ROBLOX_FRESH_KEYS, "precision"]);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["minecraft", "minecraft", "last-release", "Minecraft Last Release"], "same data file and page as V1");
    assert.equal(fresh.nextEventUtc, "2026-09-15T11:23:02.000Z");
    assert.equal(fresh.notes, "Java Edition 26.3");
    assert.equal(fresh.source_url, MINECRAFT_CHANGELOGS_PAGE, "visitors get the changelogs page, not the manifest JSON");
    assert.deepEqual([fresh.confidence, fresh.fetch_mode, fresh.http_status], ["high", "http", 200]);
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });

    const k1 = store.load("minecraft");
    assert.deepEqual(k1.events.map(e => [e.key, e.kind, e.status, e.at, e.precision, e.timezone]), [["minecraft/last-release/26.3", "version", "observed", "2026-09-15T11:23:02.000Z", "exact", "UTC"]]);
    assert.equal(k1.documents.length, 1);
    assert.deepEqual([k1.documents[0].url, k1.documents[0].id], [MINECRAFT_MANIFEST_URL, k1.sources[0].textHash], "the evidence is the manifest that was fetched");
    assert.deepEqual(k1.claims.map(c => [c.field, c.value, c.method, c.documentId]), [["at", "2026-09-15T11:23:02.000Z", "deterministic", k1.documents[0].id]]);
    assert.ok(CURRENT.includes(k1.claims[0].quote!), "the quote is copied from the fetched response");
    assert.equal(JSON.parse(k1.claims[0].quote!).releaseTime, "2026-09-15T11:23:02+00:00");
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.deepEqual([second.created, second.changes.length], [0, 0], "an unchanged run still learns nothing");
    // This capture holds a single release, so the store can never reach KEPT_RELEASES and the adapter
    // keeps re-reading the body in case there is history in it. Reported as deterministic work because
    // that is what it is: `unchanged` in the run report means "skipped without parsing" (Codex, #66).
    // A manifest with a real history reaches the cap on its first run and skips from then on, which the
    // history test below asserts directly.
    assert.deepEqual(second.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });
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
    const evidenced = store.load("minecraft");
    assert.deepEqual([evidenced.documents.length, evidenced.claims.length], [2, 2], "a manifest that changed only for snapshots adds no evidence copies");
});

test("a manifest that cannot vouch for a release keeps the last release published as stale and is examined again next run", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: CURRENT }] })), store, NOW);
    const goodHash = store.load("minecraft").sources[0].textHash;

    const dangling = edit(CURRENT, m => { m.latest.release = "26.4"; });
    for (const at of ["2026-09-16T06:00:00Z", "2026-09-16T12:00:00Z"]) {
        const run = await runTracker(game, topic, createMinecraftJavaAdapter(fakeTransport({ http: [{ body: dangling }] })), store, new Date(at));
        assert.equal(run.result.status, "stale");
        assert.equal((run.result as any).reason_code, "extraction-failed");
        assert.match(run.failureDetail ?? "", /has no entry/);
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

/**
 * The rescue (PR 3). The page published one date and nothing else, because this adapter stored only
 * `latest.release` and let history accumulate from its first run — which after a month was still one
 * row. The manifest has always carried every version Minecraft has ever had, in the same response the
 * build already pays for. It simply was not read.
 */
const HISTORY = fixture("mojang-version-manifest-history.json");

test("the releases behind the current one come out of the same response", () => {
    const kept = parseRecentJavaReleases(HISTORY);
    assert.equal(kept.length, KEPT_RELEASES, "the page keeps what it can draw, and no more");
    assert.equal(kept[0].id, parseLatestJavaRelease(HISTORY).id, "the newest kept release is the current one");

    // Newest first, by releaseTime — never by position. The fixture lists them shuffled on purpose,
    // because the array's order is Mojang's business and has changed before.
    const times = kept.map(release => Date.parse(release.at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), "not ordered by release time");

    // Releases only. /minecraft/last-release/ has always meant releases, and the manifest's own `type`
    // is what decides — so this is the source's distinction, not one we invented.
    const manifested = manifest(HISTORY);
    for (const release of kept) {
        assert.equal(manifested.versions.find(v => v.id === release.id)!.type, "release", `${release.id} is not a release`);
        assert.ok(HISTORY.includes(release.excerpt), `${release.id} is not quotable from the response`);
    }
    assert.equal(kept.filter(r => /-rc-|-pre-|w\d\d[a-z]/.test(r.id)).length, 0, "a test build reached the page");
});

test("a release the manifest cannot vouch for is skipped, and does not cost the page its history", () => {
    // Deliberately lenient where the current release is strict: one unquotable old entry must not take
    // eleven good rows with it. parseLatestJavaRelease still throws for the current release.
    assert.deepEqual(parseRecentJavaReleases(edit(HISTORY, m => {
        m.versions = m.versions.map(v => (v.id === "25.3" ? { ...v, releaseTime: "not-a-date" } : v));
    })).map(r => r.id).includes("25.3"), false);

    assert.throws(() => parseRecentJavaReleases("<html>maintenance</html>"), /Invalid JSON/);
    assert.throws(() => parseRecentJavaReleases(JSON.stringify({ latest: {} })), /No versions/);
    assert.deepEqual(parseRecentJavaReleases(JSON.stringify({ versions: [] })), [], "a manifest with no releases has no history");
});

test("a run stores the history, each release evidenced by the manifest it was read from", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { gate } = noModelGate(ledger);
    const transport = fakeTransport({ http: [{ body: HISTORY, headers: { "content-type": "application/json" } }, { body: HISTORY, headers: { "content-type": "application/json" } }] });
    const adapter = createMinecraftJavaAdapter(transport);

    const run = await runTracker(game, topic, adapter, store, new Date("2026-11-11T00:00:00Z"), { ai: gate });
    assert.equal(run.result.status, "fresh");

    const k = store.load("minecraft");
    assert.equal(k.events.length, KEPT_RELEASES, "the page's history is not in the store");
    assert.deepEqual(k.events.map(e => e.label).sort(), parseRecentJavaReleases(HISTORY).map(r => r.id).sort());
    for (const event of k.events) {
        assert.equal(event.kind, "version");
        assert.equal(event.precision, "exact");
        assert.equal(event.publishState, "published");
    }

    // One document — they all came out of the same response — and a claim each, because each release's
    // entry is a verbatim quote of it. `blocksFor` will not list a past event it cannot show evidence
    // for, so storing the rows without claims was a way to have the history and never display it.
    assert.equal(k.documents.length, 1, "the manifest was stored more than once");
    assert.equal(k.claims.length, KEPT_RELEASES, "a release was stored without the evidence for it");
    assert.deepEqual(
        k.claims.map(c => c.eventKey).sort(),
        k.events.map(e => e.key).sort(),
        "every stored release is evidenced, and nothing is evidenced that is not stored"
    );
    for (const claim of k.claims) {
        assert.equal(claim.documentId, k.documents[0].id);
        assert.equal(claim.method, "deterministic");
        assert.ok(HISTORY.includes(claim.quote!), "the quote is not a verbatim slice of the response");
        // The evidence is the manifest; the link a reader is given is where Mojang writes releases up.
        assert.equal(claim.linkUrl, MINECRAFT_CHANGELOGS_PAGE, "a row would cite raw launcher JSON");
    }
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k))));

    // And the value the page publishes is still the current release, unchanged by any of this.
    const fresh = run.result as Extract<typeof run.result, { status: "fresh" }>;
    assert.equal(fresh.notes, "Java Edition 26.4");
    assert.equal(fresh.nextEventUtc, "2026-11-10T10:00:00.000Z");

    // The whole point: twelve releases for one request, and nothing sent to a model. The history was
    // already in the response the build was paying for.
    assert.equal(transport.gets.length, 1, "history cost an extra request");
    assert.deepEqual(run.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });

    // A second run over the same manifest adds nothing: evidence is written once per release.
    const again = await runTracker(game, topic, adapter, store, new Date("2026-11-11T06:00:00Z"), { ai: gate });
    assert.equal(again.result.status, "fresh");
    const k2 = store.load("minecraft");
    assert.deepEqual([k2.events.length, k2.documents.length, k2.claims.length], [KEPT_RELEASES, 1, KEPT_RELEASES], "idempotent");
});

test("once the history is in, an unchanged manifest is skipped without parsing again", async () => {
    // Codex, #66: re-reading an unchanged body is how the backfill reaches an existing knowledge
    // branch, but doing it on every run thereafter would be work for nothing. Once the store holds as
    // much as a run would ever take from the response, there is nothing left to learn from it.
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { gate } = noModelGate(ledger);
    const serve = () => fakeTransport({ http: [{ body: HISTORY, headers: { "content-type": "application/json" } }] });

    const first = await runTracker(game, topic, createMinecraftJavaAdapter(serve()), store, new Date("2026-11-11T00:00:00Z"), { ai: gate });
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });
    assert.equal(store.load("minecraft").events.length, KEPT_RELEASES);

    const second = await runTracker(game, topic, createMinecraftJavaAdapter(serve()), store, new Date("2026-11-11T06:00:00Z"), { ai: gate });
    assert.deepEqual(second.work, { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 }, "the response was parsed again for nothing");
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
});

test("a legacy claim without a reader's link is upgraded rather than trusted", async () => {
    // Codex, #66: evidence is append-only (pipeline.ts drops a claim whose id is already stored), so an
    // upgrade cannot improve a claim in place. Before the rescue the current release's claim carried no
    // linkUrl, and treating it as "already evidenced" would have left that row pointing readers at raw
    // launcher JSON for good. The link is part of the claim id, so a better claim is appended, and
    // evidenceFor takes the newest.
    const { store } = tempStore();
    const serve = () => fakeTransport({ http: [{ body: HISTORY, headers: { "content-type": "application/json" } }] });
    await runTracker(game, topic, createMinecraftJavaAdapter(serve()), store, new Date("2026-11-11T00:00:00Z"));

    // Wind the store back to what the old adapter wrote: one release, one claim, no link — and the id
    // it would have had, which did not include the link. Spreading the new claim and dropping its
    // linkUrl is not a legacy claim: it keeps the new id, so the pipeline would dedupe the upgrade away
    // and the test would pass for the wrong reason.
    const before = store.load("minecraft");
    const currentKey = "minecraft/last-release/26.4";
    const current = before.claims.find(c => c.eventKey === currentKey)!;
    const legacyId = createHash("sha256")
        .update(`${current.documentId}|${currentKey}|at|${current.value}`)
        .digest("hex").slice(0, 24);
    assert.notEqual(legacyId, current.id, "the id scheme did not change, so an upgrade could never append");
    const legacy = { ...current, id: legacyId, linkUrl: undefined };
    store.save({ ...before, events: before.events.filter(e => e.key === currentKey), claims: [legacy] });
    assert.equal(store.load("minecraft").claims[0].linkUrl, undefined, "the store was not wound back");

    await runTracker(game, topic, createMinecraftJavaAdapter(serve()), store, new Date("2026-11-11T06:00:00Z"));
    const after = store.load("minecraft");
    const forCurrent = after.claims.filter(c => c.eventKey === currentKey);
    assert.ok(forCurrent.some(c => c.linkUrl === MINECRAFT_CHANGELOGS_PAGE), "the legacy claim was trusted and the link never arrived");
});

test("a legacy store that reached the cap the slow way is still upgraded", async () => {
    // Codex, #66 round 3: the short-circuit counted events, and a count cannot tell a completed import
    // from a store that accumulated the same number one run at a time over a year. Such a store passes
    // any count test while every claim still lacks the reader's link — so it would have exited before
    // the upgrade loop and kept those rows pointing at raw launcher JSON until the hash changed.
    const { store } = tempStore();
    const serve = () => fakeTransport({ http: [{ body: HISTORY, headers: { "content-type": "application/json" } }] });
    await runTracker(game, topic, createMinecraftJavaAdapter(serve()), store, new Date("2026-11-11T00:00:00Z"));

    // The same twelve releases, but evidenced the old way: ids without the link, and no linkUrl.
    const before = store.load("minecraft");
    assert.equal(before.events.length, KEPT_RELEASES, "this test needs a store at the cap");
    const legacy = before.claims.map(claim => ({
        ...claim,
        id: createHash("sha256").update(`${claim.documentId}|${claim.eventKey}|at|${claim.value}`).digest("hex").slice(0, 24),
        linkUrl: undefined
    }));
    store.save({ ...before, claims: legacy });
    assert.equal(store.load("minecraft").claims.every(c => c.linkUrl === undefined), true, "the store was not wound back");

    // Identical bytes: smartFetch reports unchanged, and the links are still repaired.
    const again = serve();
    await runTracker(game, topic, createMinecraftJavaAdapter(again), store, new Date("2026-11-11T06:00:00Z"));
    assert.equal(again.gets.length, 1, "the upgrade cost an extra request");
    const after = store.load("minecraft");
    for (const event of after.events) {
        assert.ok(
            after.claims.some(c => c.eventKey === event.key && c.linkUrl === MINECRAFT_CHANGELOGS_PAGE),
            `${event.key} still has no reader's link`
        );
    }
});
