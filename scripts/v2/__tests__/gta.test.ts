import test from "node:test";
import assert from "node:assert/strict";
import { gtaWeeklyResetAdapter, nextWeeklyReset } from "../adapters/gta";
import { findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { V1_GTA_FRESH_KEYS, tempStore } from "./helpers";

const game = findGame("gta");
const topic = findTopic(game, "weekly-reset");

test("next reset is the following Thursday 10:00 UTC", () => {
    assert.equal(nextWeeklyReset(new Date("2026-09-14T12:00:00Z")).toISOString(), "2026-09-17T10:00:00.000Z"); // Monday
    assert.equal(nextWeeklyReset(new Date("2026-09-20T00:00:00Z")).toISOString(), "2026-09-24T10:00:00.000Z"); // Sunday
    assert.equal(nextWeeklyReset(new Date("2026-09-16T23:59:59Z")).toISOString(), "2026-09-17T10:00:00.000Z"); // Wednesday night
});

test("boundary around the reset instant on Thursday", () => {
    assert.equal(nextWeeklyReset(new Date("2026-09-17T09:59:59.999Z")).toISOString(), "2026-09-17T10:00:00.000Z");
    // Exactly at the reset the reset has happened: next one is a week away (V1 returned the same instant).
    assert.equal(nextWeeklyReset(new Date("2026-09-17T10:00:00.000Z")).toISOString(), "2026-09-24T10:00:00.000Z");
    assert.equal(nextWeeklyReset(new Date("2026-09-17T10:00:00.001Z")).toISOString(), "2026-09-24T10:00:00.000Z");
    assert.equal(nextWeeklyReset(new Date("2026-09-17T10:00:30.000Z")).toISOString(), "2026-09-24T10:00:00.000Z");
    assert.equal(nextWeeklyReset(new Date("2026-09-17T11:00:00.000Z")).toISOString(), "2026-09-24T10:00:00.000Z");
});

test("repeated runs do not duplicate the event or add change records", async () => {
    const { store } = tempStore();
    const first = await runTracker(game, topic, gtaWeeklyResetAdapter, store, new Date("2026-09-14T12:00:00Z"));
    assert.equal(first.created, 1);
    assert.equal(first.changes.length, 1);
    assert.equal(first.changes[0].field, "event");

    const second = await runTracker(game, topic, gtaWeeklyResetAdapter, store, new Date("2026-09-14T18:00:00Z"));
    assert.equal(second.created, 0);
    assert.equal(second.changes.length, 0);

    const knowledge = store.load("gta");
    assert.equal(knowledge.events.length, 1);
    assert.equal(knowledge.changes.length, 1);
    assert.equal(knowledge.events[0].key, "gta/weekly-reset/2026-09-17");
    assert.equal(knowledge.events[0].firstSeen, "2026-09-14T12:00:00.000Z");
    assert.equal(knowledge.events[0].lastVerified, "2026-09-14T18:00:00.000Z");
});

test("rollover past the reset ends the old event and schedules the next, keeping history", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, gtaWeeklyResetAdapter, store, new Date("2026-09-17T09:00:00Z"));
    const after = await runTracker(game, topic, gtaWeeklyResetAdapter, store, new Date("2026-09-17T12:00:00Z"));

    assert.equal(after.created, 1);
    assert.deepEqual(after.changes.map(c => [c.entityKey, c.field, c.oldValue, c.newValue]), [
        ["gta/weekly-reset/2026-09-24", "event", null, "Weekly reset @ 2026-09-24T10:00:00.000Z"],
        ["gta/weekly-reset/2026-09-17", "status", "scheduled", "ended"]
    ]);

    const knowledge = store.load("gta");
    assert.equal(knowledge.events.length, 2);
    const ended = knowledge.events.find(e => e.key === "gta/weekly-reset/2026-09-17")!;
    assert.equal(ended.status, "ended");
    assert.equal(after.result.status, "fresh");
    assert.equal((after.result as any).nextEventUtc, "2026-09-24T10:00:00.000Z");
});

test("compatibility JSON matches the V1 contract", async () => {
    const { store } = tempStore();
    const now = new Date("2026-09-14T12:00:00Z");
    const { result } = await runTracker(game, topic, gtaWeeklyResetAdapter, store, now);

    assert.deepEqual(Object.keys(result), [...V1_GTA_FRESH_KEYS, "precision"]);
    assert.equal(result.status, "fresh");
    assert.equal(result.provider_id, "gta");
    assert.equal(result.game, "gta");
    assert.equal(result.type, "weekly-reset");
    assert.equal(result.title, "GTA Online Weekly Reset");
    const fresh = result as any;
    assert.equal(fresh.nextEventUtc, "2026-09-17T10:00:00.000Z");
    assert.equal(fresh.fetched_at_utc, now.toISOString());
    assert.equal(fresh.last_success_at_utc, now.toISOString());
    assert.equal(fresh.source_url, "https://www.rockstargames.com/gta-online");
    assert.equal(fresh.confidence, "high");
    assert.equal(fresh.notes, "Weekly reset occurs every Thursday at 10:00 UTC");
});
