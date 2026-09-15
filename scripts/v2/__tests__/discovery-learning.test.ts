import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { knownSourcesFor, learnedSourcesFor, recordSourceFailure, recordSourceSuccess } from "../discovery/learning";
import { emptyKnowledge } from "../domain";
import { KnowledgeValidationError } from "../validate";
import { LOL_SCHEDULE_URL, lolGame } from "./discovery-fixtures";
import { tempStore } from "./helpers";

const now = new Date("2026-09-15T06:00:00Z");
const later = new Date("2026-09-16T06:00:00Z");

test("successful official sources are learned, counted and offered before searching next time", () => {
    const game = lolGame();
    const topic = game.topics[0];
    const k = emptyKnowledge("lol", now);
    const first = recordSourceSuccess(k, topic.type, { url: `${LOL_SCHEDULE_URL}/?utm_source=x`, tier: "official", via: "sitemap", query: "League of Legends patch schedule", title: "Patch Schedule" }, now);
    assert.ok(first);
    assert.equal(first!.url, LOL_SCHEDULE_URL, "stored canonical");
    assert.equal(first!.successes, 1);
    assert.equal(first!.id, `${topic.type}:${first!.id.split(":")[1]}`);

    const again = recordSourceSuccess(k, topic.type, { url: LOL_SCHEDULE_URL, tier: "official", via: "learned" }, later);
    assert.equal(again, first, "same page, same entry");
    assert.equal(k.discovered.length, 1);
    assert.equal(first!.successes, 2);
    assert.equal(first!.lastSuccessAt, later.toISOString());
    assert.equal(first!.via, "sitemap", "how it was first found is kept");

    recordSourceSuccess(k, topic.type, { url: "https://www.leagueoflegends.com/en-us/news/tags/patch-notes", tier: "official", via: "seed" }, now);
    assert.deepEqual(learnedSourcesFor(k, topic.type).map(d => d.url), [LOL_SCHEDULE_URL, "https://www.leagueoflegends.com/en-us/news/tags/patch-notes"], "most successful first");
    assert.deepEqual(learnedSourcesFor(k, "other-topic"), []);

    // Known sources: the configured page first, then learned ones; the configured URL is not repeated.
    assert.deepEqual(knownSourcesFor(game, topic, k).map(s => [s.url, s.via]), [
        [LOL_SCHEDULE_URL, "config"],
        ["https://www.leagueoflegends.com/en-us/news/tags/patch-notes", "learned"]
    ]);
    const unconfigured = lolGame({ sources: [] });
    assert.deepEqual(knownSourcesFor(unconfigured, unconfigured.topics[0], k).map(s => s.via), ["learned", "learned"]);

    assert.equal(recordSourceFailure(k, topic.type, LOL_SCHEDULE_URL, later)?.failures, 1);
    assert.equal(recordSourceFailure(k, topic.type, "https://support.riotgames.com/en-us/never-seen", later), undefined, "failures do not create entries");
});

test("a secondary page is never learned, and the store refuses one", () => {
    const k = emptyKnowledge("lol", now);
    assert.equal(recordSourceSuccess(k, "next-patch", { url: "https://www.reddit.com/r/leagueoflegends/comments/x", tier: "secondary", via: "web" }, now), undefined);
    assert.deepEqual(k.discovered, []);

    const { store } = tempStore();
    (k.discovered as unknown[]).push({ id: "next-patch:deadbeef", url: "https://www.reddit.com/r/x", topic: "next-patch", tier: "secondary", via: "web", discoveredAt: now.toISOString(), lastSuccessAt: now.toISOString(), successes: 1, failures: 0 });
    assert.throws(() => store.save(k), (e: unknown) => e instanceof KnowledgeValidationError && /discovered\[0\]\.tier/.test(e.message));
});

test("learned sources round-trip through the store in a stable order, and old files load without them", () => {
    const { store } = tempStore();
    const k = emptyKnowledge("lol", now);
    recordSourceSuccess(k, "next-patch", { url: "https://www.leagueoflegends.com/en-us/news/tags/patch-notes", tier: "official", via: "seed" }, now);
    recordSourceSuccess(k, "next-patch", { url: LOL_SCHEDULE_URL, tier: "official", via: "sitemap", query: "q" }, now);
    store.save(k);
    const loaded = store.load("lol");
    assert.equal(loaded.discovered.length, 2);
    assert.deepEqual(loaded.discovered.map(d => d.id), [...loaded.discovered.map(d => d.id)].sort(), "sorted by id");
    assert.equal(loaded.discovered.find(d => d.url === LOL_SCHEDULE_URL)?.query, "q");
    store.save(loaded);
    assert.equal(fs.readFileSync(store.filePath("lol"), "utf8"), fs.readFileSync(store.filePath("lol"), "utf8"));

    const file = store.filePath("gta");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, game: "gta", updatedAt: now.toISOString(), events: [], changes: [], overrides: [], documents: [], claims: [], sources: [] }), "utf8");
    const legacy = store.load("gta");
    assert.deepEqual(legacy.discovered, []);
    store.save(legacy);
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8")).discovered));
});
