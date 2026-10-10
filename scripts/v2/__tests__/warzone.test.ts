/**
 * Warzone on V2: official Call of Duty patch notes page -> the Warzone card's data-date and article link ->
 * a day-precision event keyed by article and update day, with evidence quoting the fetched page -> V1-compatible view.
 * The fixture is the real page captured on 2026-09-16 with script and style bodies emptied (markup unchanged).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { KEPT_ARCHIVE, WARZONE_PATCH_NOTES_URL, createWarzonePatchAdapter, parseCardDate, parseWarzoneArchive, parseWarzoneUpdate } from "../adapters/warzone";
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
    assert.deepEqual(Object.keys(fresh), [...V1_ROBLOX_FRESH_KEYS, "precision"]);
    assert.deepEqual([fresh.provider_id, fresh.game, fresh.type, fresh.title], ["warzone", "warzone", "last-patch", "Call of Duty Warzone Last Patch"], "same data file and page as V1");
    assert.deepEqual([fresh.nextEventUtc, fresh.notes, fresh.source_url, fresh.confidence], [LATEST.at, LATEST.title, LATEST.url, "high"]);

    const k1 = store.load("warzone");
    // The current card, plus the archive beneath it. Every one at day precision: the page states a
    // day with no time or zone, and inventing one would be our value rather than Activision's.
    const archive = parseWarzoneArchive(PAGE);
    assert.equal(k1.events.length, archive.length + 1, "the archive beneath the card was not imported");
    for (const event of k1.events) assert.deepEqual([event.precision, event.timezone], ["day", undefined]);
    assert.ok(k1.events.some(e => e.key === `warzone/last-patch/${LATEST.identity}`), "the current card is not among them");

    // One document — they all came out of the same response — and a claim each, because `blocksFor`
    // will not list a past event it cannot evidence.
    assert.deepEqual([k1.documents.length, k1.claims.length], [1, archive.length + 1]);
    assert.deepEqual([k1.documents[0].id, k1.documents[0].url], [k1.sources[0].textHash, WARZONE_PATCH_NOTES_URL]);
    const currentClaim = k1.claims.find(c => c.eventKey === `warzone/last-patch/${LATEST.identity}`)!;
    assert.deepEqual([currentClaim.value, currentClaim.linkUrl, currentClaim.method], [LATEST.at, LATEST.url, "deterministic"]);
    assert.ok(PAGE.includes(currentClaim.quote!), "the current card's quote is not a verbatim slice");
    // Every archive row carries its own article link, which is the evidence a reader is shown.
    for (const claim of k1.claims) assert.match(claim.linkUrl!, /^https:\/\/www\.callofduty\.com\/patchnotes\//);
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
    const keys = store.load("warzone").events.map(e => e.key);
    assert.ok(keys.includes(`warzone/last-patch/${SLUG}-2026-08-28`), "the superseded update was dropped");
    assert.ok(keys.includes(`warzone/last-patch/${SLUG}-2026-09-15`), "the in-place update is not its own event");

    const goodHash = store.load("warzone").sources[0].textHash;
    const broken = await runTracker(game, topic, createWarzonePatchAdapter(fakeTransport({ http: [{ body: updated.replace("game-tile warzone", "game-tile mw4") }] })), store, new Date("2026-09-16T12:00:00Z"));
    assert.equal(broken.result.status, "stale");
    assert.equal((broken.result as any).nextEventUtc, "2026-09-15T00:00:00.000Z");
    assert.deepEqual([store.load("warzone").sources[0].lastVerdict, store.load("warzone").sources[0].textHash], ["parse-error", goodHash]);
});

test("a card date corrected backward retires the later update instead of keeping it published", async () => {
    const { store } = tempStore();
    const later = PAGE.replace("data-date=\"August 28, 2026\"", "data-date=\"August 30, 2026\"");
    await runTracker(game, topic, createWarzonePatchAdapter(fakeTransport({ http: [{ body: later }] })), store, NOW);

    const corrected = await runTracker(game, topic, createWarzonePatchAdapter(fakeTransport({ http: [{ body: PAGE }] })), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(corrected.result.status, "fresh");
    assert.equal((corrected.result as any).nextEventUtc, LATEST.at, "the card's corrected day is published");
    const k = store.load("warzone");
    assert.equal(k.events.find(e => e.key === `warzone/last-patch/${SLUG}-2026-08-30`)!.publishState, "held");
    assert.equal(k.events.find(e => e.key === `warzone/last-patch/${LATEST.identity}`)!.publishState, "published");
    assert.ok(corrected.changes.some(c => c.field === "publishState" && c.newValue === "held"));
});

test("the production registry runs Warzone on the patch notes page adapter", () => {
    assert.equal(game.sources[0].url, WARZONE_PATCH_NOTES_URL);
    assert.equal(topic.discovery, undefined, "a deterministic page source needs no discovery");
    assert.equal(typeof adapterFor(topic), "function");
});

/**
 * The rescue (PR 3a). I withheld this page from the index on the premise that the Call of Duty page
 * publishes one card per game and keeps no archive. That was wrong, and Codex caught it: beneath the
 * current card is a "View past patch notes" accordion carrying the previous articles with their dates
 * and links — in the very response this adapter already fetches. The decision was reversed.
 */
test("the patches behind the current one come out of the page's own archive", () => {
    const archive = parseWarzoneArchive(PAGE);
    assert.ok(archive.length > 0, "the accordion beneath the card was not read");
    assert.ok(archive.length <= KEPT_ARCHIVE, "more was kept than the page can draw");

    // Warzone's archive, not the one a few hundred lines further down. The same markup carries Black
    // Ops' past patch notes, and merging them would publish another game's patches as Warzone's.
    for (const entry of archive) {
        assert.match(entry.title, /Warzone/i, `${entry.title} is not a Warzone patch`);
        assert.match(entry.url, /^https:\/\/www\.callofduty\.com\/patchnotes\//);
        assert.ok(Number.isFinite(Date.parse(entry.at)), `${entry.title} has no readable date`);
    }
    assert.equal(archive.filter(e => /black ops|modern warfare/i.test(e.title)).length, 0, "another game's patches reached Warzone");

    // Newest first, and every row distinct.
    const times = archive.map(e => Date.parse(e.at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), "not ordered newest first");
    assert.equal(new Set(archive.map(e => e.identity)).size, archive.length, "the same article was listed twice");

    // The identity scheme is the card's, so an article moving between the card and the archive is
    // recognised as the event it already was rather than becoming a second one.
    const current = parseWarzoneUpdate(PAGE);
    assert.equal(archive.some(e => e.identity === current.identity), false, "the current card is duplicated into the archive");
});

test("a page with no archive still publishes its current card", () => {
    // The accordion is an enhancement to the page, not a requirement of it. If Activision drops it,
    // the tracker keeps working with one row rather than failing.
    const stripped = PAGE.replace(/<div class="post-grid-accordion"[\s\S]*?<\/div>\s*<\/div>/g, "");
    assert.doesNotThrow(() => parseWarzoneUpdate(stripped));
    assert.deepEqual(parseWarzoneArchive("<html><body>nothing here</body></html>"), []);
});

test("an unchanged response is still read when its body came down with it", async () => {
    // Codex, PR #66: on the first deploy after this change the store holds no history, and the page
    // reads as unchanged until Activision next patches anything. A 304 has no body and cannot be read
    // — but a 200 whose hash matched does, and importing from it costs no request at all.
    const { store } = tempStore();
    const first = fakeTransport({ http: [{ body: PAGE, headers: { "content-type": "text/html" } }] });
    await runTracker(game, topic, createWarzonePatchAdapter(first), store, NOW);

    // Wind the store back to the single-event shape this page had before the rescue, keeping the
    // source state — which is exactly what a deploy onto the existing knowledge branch looks like.
    const before = store.load("warzone");
    const current = parseWarzoneUpdate(PAGE);
    const currentKey = `warzone/last-patch/${current.identity}`;
    store.save({
        ...before,
        events: before.events.filter(e => e.key === currentKey),
        claims: before.claims.filter(c => c.eventKey === currentKey)
    });
    assert.equal(store.load("warzone").events.length, 1, "the store was not wound back");

    // The same bytes again: smartFetch reports unchanged, and the history is imported anyway.
    const again = fakeTransport({ http: [{ body: PAGE, headers: { "content-type": "text/html" } }] });
    const run = await runTracker(game, topic, createWarzonePatchAdapter(again), store, new Date("2026-09-17T00:00:00Z"));
    assert.equal(run.result.status, "fresh");
    assert.equal(again.gets.length, 1, "the backfill cost an extra request");
    assert.equal(store.load("warzone").events.length, parseWarzoneArchive(PAGE).length + 1, "the history was not backfilled");
});
