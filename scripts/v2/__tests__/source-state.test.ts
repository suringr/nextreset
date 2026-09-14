import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { emptyKnowledge } from "../domain";
import { getSourceState, putSourceState } from "../knowledge";
import { KnowledgeStoreError } from "../store";
import { tempStore } from "./helpers";

test("source fetch state round-trips and is written in a stable, sorted order", () => {
    const { store } = tempStore();
    const k = emptyKnowledge("roblox", new Date("2026-09-14T00:00:00Z"));
    putSourceState(k, { id: "zeta", url: "https://z.example/feed", consecutiveFailures: 0, textHash: "b".repeat(64) });
    putSourceState(k, { id: "alpha", url: "https://a.example/feed", consecutiveFailures: 2, etag: "\"x\"", lastVerdict: "challenge", lastMode: "browser" });
    store.save(k);

    const loaded = store.load("roblox");
    assert.deepEqual(loaded.sources.map(s => s.id), ["alpha", "zeta"]);
    assert.equal(getSourceState(loaded, "alpha")?.etag, "\"x\"");
    assert.equal(getSourceState(loaded, "missing"), undefined);

    putSourceState(loaded, { id: "alpha", url: "https://a.example/feed", consecutiveFailures: 0 });
    assert.equal(loaded.sources.length, 2, "put replaces by id");
    assert.equal(getSourceState(loaded, "alpha")?.consecutiveFailures, 0);
});

test("knowledge files written before source state existed still load", () => {
    const { store } = tempStore();
    const file = store.filePath("gta");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = { schemaVersion: 1, game: "gta", updatedAt: "2026-09-14T00:00:00.000Z", events: [], changes: [], overrides: [], documents: [], claims: [] };
    fs.writeFileSync(file, JSON.stringify(legacy), "utf8");
    const loaded = store.load("gta");
    assert.deepEqual(loaded.sources, []);
    store.save(loaded);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).sources instanceof Array);
});

test("invalid source state is rejected", () => {
    const { store } = tempStore();
    const k = emptyKnowledge("roblox");
    k.sources.push({ id: "a", url: "https://a.example", consecutiveFailures: -1 });
    assert.throws(() => store.save(k), /sources\[0\]\.consecutiveFailures/);

    const dup = emptyKnowledge("roblox");
    dup.sources.push({ id: "a", url: "https://a.example", consecutiveFailures: 0 }, { id: "a", url: "https://b.example", consecutiveFailures: 0 });
    assert.throws(() => store.save(dup), /duplicate source id a/);

    const file = store.filePath("roblox");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...emptyKnowledge("roblox"), sources: [{ id: "a", url: "https://a.example", consecutiveFailures: 0, lastMode: "carrier-pigeon" }] }), "utf8");
    assert.throws(() => store.load("roblox"), (e: unknown) => e instanceof KnowledgeStoreError && /sources\[0\]\.lastMode/.test((e as Error).message));
});
