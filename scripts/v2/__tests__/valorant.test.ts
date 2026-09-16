/**
 * VALORANT on V2: official patch notes tag page -> Next.js page data (__NEXT_DATA__) -> cards titled exactly
 * "VALORANT Patch Notes <version>" -> events keyed by version with evidence quoting the fetched page -> V1-compatible view.
 * The fixture keeps the real page structure and six real, unaltered cards from a capture on 2026-09-16.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { VALORANT_PATCH_NOTES_URL, createValorantPatchAdapter, parseValorantPatches } from "../adapters/valorant";
import { MockAiProvider } from "../ai/mock";
import { DEFAULT_AI_BUDGET_LIMITS, createAiGate } from "../cost/budget";
import { AiUsageLedger } from "../cost/ledger";
import { adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fakeTransport, fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";

const game = findGame("valorant");
const topic = findTopic(game, "last-patch");
const PAGE = fixture("valorant-patch-notes-tag.html");
const LATEST = { version: "13.05", at: "2026-09-01T13:00:00.000Z", title: "VALORANT Patch Notes 13.05", url: "https://playvalorant.com/en-us/news/game-updates/valorant-patch-notes-13-05" };
const NOW = new Date("2026-09-16T00:00:00Z");

const nextData = (html: string) => JSON.parse(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
const withPageData = (change: (data: any) => void) => {
    const data = nextData(PAGE);
    change(data);
    return PAGE.replace(/(<script id="__NEXT_DATA__" type="application\/json">)[\s\S]*?(<\/script>)/, (_m, open, close) => `${open}${JSON.stringify(data)}${close}`);
};
const grid = (data: any) => data.props.pageProps.page.blades.find((b: any) => b.type === "articleCardGrid");

function noModelGate(ledger: AiUsageLedger) {
    const model = new MockAiProvider("gemini-3.5-flash", () => { throw new Error("page data must never reach the model"); });
    return { model, gate: createAiGate({ ledger, limits: { ...DEFAULT_AI_BUDGET_LIMITS }, runId: "valorant-test", model: model.model, loadProvider: async () => model, env: {} }) };
}

test("patch notes cards are read from the page data by version at their exact publishedAt, each quoted verbatim", () => {
    const patches = parseValorantPatches(PAGE);
    assert.deepEqual(patches.map(p => [p.version, p.at]), [
        ["13.05", "2026-09-01T13:00:00.000Z"], ["13.04", "2026-08-18T13:00:00.000Z"], ["13.02", "2026-07-28T13:00:00.000Z"],
        ["13.01", "2026-07-14T13:00:00.000Z"], ["13.00", "2026-06-23T13:00:00.000Z"], ["12.11", "2026-06-09T13:00:00.000Z"]
    ]);
    assert.deepEqual([patches[0].title, patches[0].url], [LATEST.title, LATEST.url]);
    const cards = grid(nextData(PAGE)).items;
    for (const p of patches) {
        assert.ok(PAGE.includes(p.excerpt), `${p.version}: the excerpt is a slice of the fetched page`);
        assert.deepEqual(JSON.parse(p.excerpt), cards.find((c: any) => c.title === p.title));
    }
});

test("the card grid is found by type, other cards and malformed entries are ignored, and a missing or reshaped page throws", () => {
    const reordered = withPageData(d => d.props.pageProps.page.blades.reverse());
    assert.equal(parseValorantPatches(reordered)[0].version, "13.05", "the grid is found by type, not position");

    const mixed = withPageData(d => {
        const items = grid(d).items;
        items.unshift({ ...items[0], title: "VALORANT Champions 2026 // Official Trailer", publishedAt: "2026-09-10T16:00:00.000Z" });
        items.unshift({ ...items[0], title: "VALORANT Patch Notes 13.06", publishedAt: "soon" });
        items.unshift({ ...items[0], title: "VALORANT Patch Notes 13.06", publishedAt: "2026-09-15T13:00:00.000Z", action: { payload: { url: "https://evil.example/patch" } } });
    });
    const patches = parseValorantPatches(mixed);
    assert.deepEqual(patches.slice(0, 2).map(p => [p.version, p.url]), [["13.06", VALORANT_PATCH_NOTES_URL], ["13.05", LATEST.url]], "a trailer and an undated card are ignored; an off-site link falls back to the patch notes page");

    const many = withPageData(d => {
        const items = grid(d).items;
        for (let i = 0; i < 8; i++) items.push({ ...items[0], title: `VALORANT Patch Notes 11.0${i}`, publishedAt: `2026-01-0${i + 1}T13:00:00.000Z` });
    });
    const kept = parseValorantPatches(many);
    assert.equal(kept.length, 10, "only the newest 10 of 14 patches are kept");
    assert.deepEqual([kept[0].version, kept[9].version], ["13.05", "11.04"]);

    assert.throws(() => parseValorantPatches("<html><body>Access denied</body></html>"), /No __NEXT_DATA__/);
    assert.throws(() => parseValorantPatches(withPageData(d => { d.props.pageProps.page.blades = [{ type: "textMasthead" }]; })), /No article card grid/);
});

test("the first run publishes the latest patch with a link to its article; an unchanged run changes nothing and makes no model call", async () => {
    const { store } = tempStore();
    const ledger = AiUsageLedger.inMemory();
    const { model, gate } = noModelGate(ledger);
    const transport = fakeTransport({ http: [{ body: PAGE, headers: { "content-type": "text/html; charset=utf-8" } }] });
    const adapter = createValorantPatchAdapter(transport);

    const first = await runTracker(game, topic, adapter, store, NOW, { ai: gate });
    assert.equal(transport.gets[0].url, VALORANT_PATCH_NOTES_URL);
    assert.equal(first.result.status, "fresh");
    const fresh = first.result as Extract<typeof first.result, { status: "fresh" }>;
    assert.deepEqual(Object.keys(fresh), [...V1_ROBLOX_FRESH_KEYS, "precision"]);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["valorant", "valorant", "last-patch", "VALORANT Last Patch"], "same data file and page as V1");
    assert.deepEqual([fresh.nextEventUtc, fresh.notes, fresh.source_url], [LATEST.at, LATEST.title, LATEST.url]);
    assert.deepEqual([fresh.confidence, fresh.fetch_mode, fresh.http_status], ["high", "http", 200]);
    assert.deepEqual(first.work, { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 });

    const k1 = store.load("valorant");
    assert.equal(k1.events.length, 6);
    assert.deepEqual([k1.documents.length, k1.claims.length], [1, 6]);
    assert.deepEqual([k1.documents[0].id, k1.documents[0].url], [k1.sources[0].textHash, VALORANT_PATCH_NOTES_URL], "the evidence is the page that was fetched");
    const claim = k1.claims.find(c => c.eventKey === "valorant/last-patch/13.05")!;
    assert.deepEqual([claim.value, claim.method, claim.linkUrl], [LATEST.at, "deterministic", LATEST.url]);
    assert.ok(PAGE.includes(claim.quote!));
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k1))));

    const second = await runTracker(game, topic, adapter, store, new Date("2026-09-16T06:00:00Z"), { ai: gate });
    assert.equal(second.result.status, "fresh");
    assert.deepEqual([second.created, second.changes.length], [0, 0]);
    assert.deepEqual(second.work, { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 });
    assert.equal(model.requests.length, 0);
    assert.equal(ledger.calls("2026-09-16").length, 0);
});

test("a page without patch notes cards, or without page data, keeps the last patch published as stale", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createValorantPatchAdapter(fakeTransport({ http: [{ body: PAGE }] })), store, NOW);
    const goodHash = store.load("valorant").sources[0].textHash;
    const trailersOnly = withPageData(d => { for (const item of grid(d).items) item.title = "VALORANT Champions 2026 // Official Trailer"; });
    const run = await runTracker(game, topic, createValorantPatchAdapter(fakeTransport({ http: [{ body: trailersOnly }] })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(run.result.status, "stale");
    assert.equal((run.result as any).nextEventUtc, LATEST.at);
    assert.deepEqual([store.load("valorant").sources[0].lastVerdict, store.load("valorant").sources[0].textHash], ["no-update-posts", goodHash]);
});

test("the production registry runs VALORANT on the patch notes page adapter", () => {
    assert.equal(game.sources[0].url, VALORANT_PATCH_NOTES_URL);
    assert.equal(topic.discovery, undefined, "a structured source needs no discovery");
    assert.equal(typeof adapterFor(topic), "function");
});
