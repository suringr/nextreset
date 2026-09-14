import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { GameKnowledge, emptyKnowledge } from "../domain";
import { JsonKnowledgeStore, KnowledgeStoreError, serializeKnowledge } from "../store";
import { KnowledgeValidationError } from "../validate";
import { tempStore } from "./helpers";

function sampleKnowledge(): GameKnowledge {
    const k = emptyKnowledge("gta", new Date("2026-09-14T00:00:00Z"));
    k.events.push({
        key: "gta/weekly-reset/2026-09-17",
        game: "gta",
        topic: "weekly-reset",
        kind: "recurring",
        label: "Weekly reset",
        status: "scheduled",
        at: "2026-09-17T10:00:00.000Z",
        precision: "exact",
        timezone: "UTC",
        firstSeen: "2026-09-14T00:00:00.000Z",
        lastVerified: "2026-09-14T00:00:00.000Z",
        publishState: "published"
    });
    k.changes.push({ entityKey: "gta/weekly-reset/2026-09-17", field: "event", oldValue: null, newValue: "Weekly reset @ 2026-09-17T10:00:00.000Z", at: "2026-09-14T00:00:00.000Z", reason: "test", decision: "applied" });
    k.overrides.push({ eventKey: "gta/weekly-reset/2026-09-17", field: "at", value: "2026-09-17T10:00:00.000Z", reason: "pinned by test", setAt: "2026-09-14T00:00:00.000Z" });
    k.documents.push({ id: "abc", url: "https://example.test/doc", sourceId: "gta-weekly-reset-rule", fetchedAt: "2026-09-14T00:00:00.000Z", fetchMode: "http" });
    k.claims.push({ id: "c1", documentId: "abc", eventKey: "gta/weekly-reset/2026-09-17", field: "at", value: "2026-09-17T10:00:00.000Z", method: "deterministic", extractedAt: "2026-09-14T00:00:00.000Z" });
    return k;
}

test("empty store initialization: load returns an empty document and writes nothing", () => {
    const { store, dir } = tempStore();
    const k = store.load("gta");
    assert.equal(k.schemaVersion, 1);
    assert.equal(k.game, "gta");
    assert.deepEqual(k.events, []);
    assert.deepEqual(k.changes, []);
    assert.equal(fs.existsSync(store.filePath("gta")), false);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test("read/write round trip preserves every entity", () => {
    const { store } = tempStore();
    const original = sampleKnowledge();
    store.save(original);
    const loaded = store.load("gta");
    assert.deepEqual(loaded, JSON.parse(serializeKnowledge(original)));
    assert.equal(loaded.events.length, 1);
    assert.equal(loaded.changes.length, 1);
    assert.equal(loaded.overrides.length, 1);
    assert.equal(loaded.documents.length, 1);
    assert.equal(loaded.claims.length, 1);
});

test("schema validation rejects invalid documents on save with a path", () => {
    const { store } = tempStore();
    const bad = sampleKnowledge();
    (bad.events[0] as any).kind = "banner";
    assert.throws(() => store.save(bad), (e: unknown) => e instanceof KnowledgeValidationError && /events\[0\]\.kind/.test((e as Error).message));

    const missingAt = sampleKnowledge();
    delete (missingAt.events[0] as any).at;
    assert.throws(() => store.save(missingAt), /events\[0\]\.at: is required for recurring events/);

    const wrongGame = sampleKnowledge();
    wrongGame.events[0].key = "roblox/weekly-reset/2026-09-17";
    assert.throws(() => store.save(wrongGame), /belongs to game roblox/);

    const duplicate = sampleKnowledge();
    duplicate.events.push({ ...duplicate.events[0] });
    assert.throws(() => store.save(duplicate), /duplicate event key/);
});

test("corrupt JSON on disk fails clearly and is not replaced", () => {
    const { store } = tempStore();
    const file = store.filePath("gta");
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json", "utf8");
    assert.throws(() => store.load("gta"), (e: unknown) => e instanceof KnowledgeStoreError && /not valid JSON/.test((e as Error).message) && (e as KnowledgeStoreError).file === file);
    assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json");
});

test("schema violations on disk fail clearly", () => {
    const { store } = tempStore();
    const file = store.filePath("roblox");
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, game: "roblox" }), "utf8");
    assert.throws(() => store.load("roblox"), /schema violation: games\/roblox\.json\.schemaVersion: must be 1/);
});

test("repeated save is byte-for-byte stable regardless of event order", () => {
    const { store } = tempStore();
    const k = sampleKnowledge();
    k.events.push({ ...k.events[0], key: "gta/weekly-reset/2026-09-10", at: "2026-09-10T10:00:00.000Z", status: "ended" });
    store.save(k);
    const first = fs.readFileSync(store.filePath("gta"), "utf8");

    const reloaded = store.load("gta");
    store.save(reloaded);
    const second = fs.readFileSync(store.filePath("gta"), "utf8");
    assert.equal(second, first);

    const reordered = sampleKnowledge();
    reordered.events.unshift({ ...k.events[1] });
    store.save(reordered);
    const third = fs.readFileSync(store.filePath("gta"), "utf8");
    assert.equal(third, first);

    assert.ok(first.endsWith("\n"));
    assert.equal(JSON.parse(first).events[0].key, "gta/weekly-reset/2026-09-10");
});

test("game ids are restricted to safe path segments", () => {
    const { store } = tempStore();
    assert.throws(() => store.load("../etc"), KnowledgeStoreError);
    assert.throws(() => store.load("GTA"), KnowledgeStoreError);
});
