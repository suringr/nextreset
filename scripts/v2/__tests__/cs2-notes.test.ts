/**
 * The CS2 "what changed" pilot: section headings and change counts from Valve's own notes, read from
 * whole posts the knowledge store already holds. The full fixture is a real response (maxlength=0)
 * captured on 22 October 2026: twenty posts, nineteen of them "Counter-Strike 2 Update".
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { CS2_NEWS_URL, createCs2UpdatesAdapter } from "../adapters/cs2";
import { findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fakeTransport, fixture } from "./fake-transport";
import { tempStore } from "./helpers";
import { blocksFor, renderBlocks } from "../../render-data-blocks";
import { formatDate } from "../../render-pages";
import { isWholePostRead, noteSectionsFor, sectionsOf } from "../../patch-notes";

const game = findGame("cs2");
const topic = findTopic(game, "last-update");
const FULL = fixture("steam-cs2-news-api-full.json");
const EXCERPTS = fixture("steam-cs2-news-api.json");
const NOW = new Date("2026-10-22T12:00:00Z");
const OLD_URL = CS2_NEWS_URL.replace("maxlength=0", "maxlength=240");
const json = (body: string) => ({ body, headers: { "content-type": "application/json; charset=UTF-8" } });

test("the source asks for whole posts, and only a whole-post read counts as one", () => {
    assert.match(CS2_NEWS_URL, /[?&]maxlength=0(&|$)/);
    assert.equal(isWholePostRead(CS2_NEWS_URL), true);
    assert.equal(isWholePostRead(OLD_URL), false);
    assert.equal(isWholePostRead("not a url"), false);
});

test("every update post in the real response has sections whose counts add up to its list items", () => {
    const items = JSON.parse(FULL).appnews.newsitems as Array<{ title: string; contents: string; date: number }>;
    const updates = items.filter(i => i.title === "Counter-Strike 2 Update");
    assert.equal(updates.length, 19);
    for (const post of updates) {
        const sections = sectionsOf(post.contents);
        assert.ok(sections, `no sections read from the ${new Date(post.date * 1000).toISOString().slice(0, 10)} post`);
        const total = (post.contents.match(/\[\*\]/g) ?? []).length;
        assert.equal(sections!.reduce((n, s) => n + s.items, 0), total, `counts do not add up for ${new Date(post.date * 1000).toISOString().slice(0, 10)}`);
    }
    const newest = sectionsOf(updates[0].contents)!;
    assert.deepEqual(newest.map(s => [s.name, s.items]), [["UI", 4], ["Misc", 5]]);
    const big = sectionsOf(updates.find(u => u.contents.includes("PREMIER"))!.contents)!;
    assert.deepEqual(big.map(s => s.name), ["Premier", "Rush", "Gameplay", "Settings", "Engine", "Maps", "Misc", "Workshop", "Scripting"]);
});

test("a shape that cannot be counted honestly is not summarised at all", () => {
    assert.equal(sectionsOf("[p]Release notes[/p]"), undefined, "no headings");
    assert.equal(sectionsOf("[list][*]a[/*][/list][p]\\[ MISC ][/p][list][*]b[/*][/list]"), undefined, "items outside every heading");
    assert.equal(sectionsOf("[p]\\[ MAPS ][/p][p]\\[ MISC ][/p][list][*]b[/*][/list]"), undefined, "a heading with nothing under it");
    assert.deepEqual(sectionsOf("[p]\\[ MAP SCRIPTING ][/p][list][*]a[/*][*]b[/*][/list]"), [{ name: "Map scripting", items: 2 }]);
});

test("a store from before the pilot gains one whole-post claim per known post, once, and nothing else changes", async () => {
    const { store } = tempStore();
    // The production store today: posts evidenced by 240-character excerpts from the old URL.
    await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [json(EXCERPTS)] })), store, new Date("2026-09-16T00:00:00Z"));
    const before = store.load("cs2");
    for (const d of before.documents) d.url = OLD_URL;
    for (const s of before.sources) s.url = OLD_URL;
    store.save(before);
    const eventsBefore = JSON.stringify(before.events.map(e => [e.key, e.at, e.status]));

    const run = await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [json(FULL)] })), store, NOW);
    assert.equal(run.result.status, "fresh");
    const after = store.load("cs2");
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(after))));
    const known = new Set(before.events.map(e => e.key));
    const added = after.claims.filter(c => !before.claims.some(b => b.id === c.id));
    const upgraded = added.filter(c => known.has(c.eventKey));
    assert.ok(upgraded.length > 0, "known posts in the whole response gain whole-post evidence");
    assert.equal(new Set(upgraded.map(c => c.eventKey)).size, upgraded.length, "one claim per post");
    for (const claim of upgraded) {
        const stated = before.claims.find(b => b.eventKey === claim.eventKey)!;
        assert.equal(claim.value, stated.value, "the same fact");
        assert.equal(claim.linkUrl, stated.linkUrl, "the same link");
        assert.ok(isWholePostRead(after.documents.find(d => d.id === claim.documentId)!.url));
    }
    assert.equal(JSON.stringify(after.events.filter(e => known.has(e.key)).map(e => [e.key, e.at, e.status])), eventsBefore, "no known event moved");

    // A second whole-post run adds nothing: the evidence is whole now.
    const claims = after.claims.length;
    await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [json(FULL.replace('"count":20', '"count": 20'))] })), store, new Date("2026-10-22T18:00:00Z"));
    assert.equal(store.load("cs2").claims.length, claims);
});

test("the page shows sections for whole posts, nothing for excerpts, and the latest update's notes under the headline", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [json(EXCERPTS)] })), store, new Date("2026-09-16T00:00:00Z"));
    const k0 = store.load("cs2");
    for (const d of k0.documents) d.url = OLD_URL;
    store.save(k0);
    await runTracker(game, topic, createCs2UpdatesAdapter(fakeTransport({ http: [json(FULL)] })), store, NOW);
    const k = store.load("cs2") as any;
    const newest = [...k.events].sort((a: any, b: any) => Date.parse(b.at) - Date.parse(a.at))[0];

    const blocks = blocksFor(k, "last-update", { format: (iso: string) => formatDate(iso), now: NOW, currentKey: newest.key, headlineAnswered: true });
    const latest = blocks.find(b => b.title === "In the latest update's notes")!;
    assert.deepEqual(latest.rows.map(r => [r.label, r.when]), [["UI", "4 changes listed"], ["Misc", "5 changes listed"]]);
    assert.match(latest.note!, /9 in all/);

    const html = renderBlocks(blocks);
    const $ = cheerio.load(html);
    const details = $(".data-detail").map((_, d) => $(d).text()).get();
    assert.ok(details.length > 0);
    assert.ok(details.every(d => /^([A-Z][\w ]*[a-zA-Z] — \d+ changes? listed|[A-Z][\w ]* \d+( · [A-Z][\w ]* \d+)+ — \d+ changes? listed)$/.test(d)), details.join("\n"));
    assert.ok(details.includes("Misc — 7 changes listed"), "one section: no breakdown");
    assert.ok(details.includes("Misc 1 · Crosshair 8 — 9 changes listed"), "several: each with its count");

    // An event whose only evidence is an excerpt shows no breakdown at all.
    const excerptOnly = k.events.find((e: any) => !k.claims.some((c: any) => c.eventKey === e.key && isWholePostRead(k.documents.find((d: any) => d.id === c.documentId)?.url ?? "")));
    if (excerptOnly) assert.equal(noteSectionsFor(excerptOnly, k), undefined);
});

test("only the pilot tracker is summarised", () => {
    const pubg = { game: "pubg", events: [], claims: [], documents: [] };
    assert.equal(noteSectionsFor({ key: "pubg/last-patch/43.2", topic: "last-patch", label: "x", status: "observed", at: "2026-10-13T06:00:00Z" }, pubg), undefined);
});
