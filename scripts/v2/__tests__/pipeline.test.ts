import test from "node:test";
import assert from "node:assert/strict";
import { createRobloxStatusAdapter } from "../adapters/roblox";
import { GameKnowledge } from "../domain";
import { findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { KnowledgeStore } from "../store";
import { fakeTransport } from "./fake-transport";
import fixture from "./fixtures/roblox-hostedstatus.json";
import { tempStore } from "./helpers";

const game = findGame("roblox");
const topic = findTopic(game, "status");

/** Wraps a store so that writes fail after `allowedSaves` successful ones. */
function failingSaves(inner: KnowledgeStore, allowedSaves: number): KnowledgeStore & { saves: number } {
    const wrapper = {
        saves: 0,
        load: (gameId: string) => inner.load(gameId),
        describe: (gameId: string) => inner.describe(gameId),
        save: (knowledge: GameKnowledge) => {
            wrapper.saves++;
            if (wrapper.saves > allowedSaves) throw new Error("EROFS: read-only file system");
            inner.save(knowledge);
        }
    };
    return wrapper;
}

test("a failing save does not turn stored knowledge into 'unavailable' on a fetch failure", async () => {
    const { store } = tempStore();
    const guarded = failingSaves(store, 1);
    const first = await runTracker(game, topic, createRobloxStatusAdapter(fakeTransport({ http: [{ body: JSON.stringify(fixture) }] })), guarded, new Date("2026-09-14T12:00:00Z"));
    assert.equal(first.result.status, "fresh");
    assert.equal(first.saveError, undefined);

    const failing = fakeTransport({ http: [{ status: 503, body: "" }] });
    const run = await runTracker(game, topic, createRobloxStatusAdapter(failing), guarded, new Date("2026-09-14T18:00:00Z"));
    assert.equal(run.result.status, "stale", "stored knowledge is still served");
    assert.equal((run.result as any).nextEventUtc, "2026-08-07T04:48:28.252Z");
    assert.match(run.saveError ?? "", /EROFS/);
    // The file on disk is untouched by the failed write.
    assert.equal(store.load("roblox").sources[0].consecutiveFailures, 0);
});

test("a failing save still returns the fresh result computed in memory", async () => {
    const { store } = tempStore();
    const guarded = failingSaves(store, 0);
    const run = await runTracker(game, topic, createRobloxStatusAdapter(fakeTransport({ http: [{ body: JSON.stringify(fixture) }] })), guarded, new Date("2026-09-14T12:00:00Z"));
    assert.equal(run.result.status, "fresh");
    assert.equal(run.created, 1);
    assert.match(run.saveError ?? "", /EROFS/);
    assert.equal(store.load("roblox").events.length, 0, "nothing was persisted");
});
