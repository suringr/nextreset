import test from "node:test";
import assert from "node:assert/strict";
import { Event, emptyKnowledge } from "../domain";
import { findGame, findTopic } from "../games";
import { deriveProviderResult, selectCurrentEvent } from "../views";
import { V1_GTA_FRESH_KEYS, V1_ROBLOX_FRESH_KEYS, V1_UNAVAILABLE_KEYS } from "./helpers";

const gtaTopic = findTopic(findGame("gta"), "weekly-reset");
const robloxTopic = findTopic(findGame("roblox"), "status");

function event(partial: Partial<Event> & { key: string; at: string }): Event {
    return {
        game: "gta",
        topic: "weekly-reset",
        kind: "recurring",
        label: "Weekly reset",
        status: "scheduled",
        precision: "exact",
        timezone: "UTC",
        firstSeen: "2026-09-01T00:00:00.000Z",
        lastVerified: "2026-09-01T00:00:00.000Z",
        publishState: "published",
        ...partial
    };
}

const now = new Date("2026-09-14T12:00:00Z");

test("selectCurrentEvent prefers the earliest future scheduled event", () => {
    const events = [
        event({ key: "gta/weekly-reset/2026-09-24", at: "2026-09-24T10:00:00.000Z" }),
        event({ key: "gta/weekly-reset/2026-09-17", at: "2026-09-17T10:00:00.000Z" }),
        event({ key: "gta/weekly-reset/2026-09-10", at: "2026-09-10T10:00:00.000Z", status: "ended" })
    ];
    assert.equal(selectCurrentEvent(events, now)?.key, "gta/weekly-reset/2026-09-17");
});

test("selectCurrentEvent falls back to the latest past event and ignores held events", () => {
    const events = [
        event({ key: "gta/weekly-reset/2026-09-03", at: "2026-09-03T10:00:00.000Z", status: "ended" }),
        event({ key: "gta/weekly-reset/2026-09-10", at: "2026-09-10T10:00:00.000Z", status: "ended" }),
        event({ key: "gta/weekly-reset/2026-09-17", at: "2026-09-17T10:00:00.000Z", publishState: "held" })
    ];
    assert.equal(selectCurrentEvent(events, now)?.key, "gta/weekly-reset/2026-09-10");
    assert.equal(selectCurrentEvent([], now), undefined);
});

test("fresh view key order matches V1 with and without fetch metadata", () => {
    const gta = emptyKnowledge("gta", now);
    gta.events.push(event({ key: "gta/weekly-reset/2026-09-17", at: "2026-09-17T10:00:00.000Z" }));
    const gtaView = deriveProviderResult(gtaTopic, gta, { now, outcome: { ok: true } });
    assert.deepEqual(Object.keys(gtaView), V1_GTA_FRESH_KEYS);

    const roblox = emptyKnowledge("roblox", now);
    roblox.events.push(event({ key: "roblox/status/2026-08-07t04-48-28z", game: "roblox", topic: "status", kind: "occurrence", label: "Operational", status: "observed", at: "2026-08-07T04:48:28.252Z" }));
    const robloxView = deriveProviderResult(robloxTopic, roblox, { now, outcome: { ok: true, httpStatus: 200, fetchMode: "http" } });
    assert.deepEqual(Object.keys(robloxView), V1_ROBLOX_FRESH_KEYS);
    assert.equal((robloxView as any).notes, "Current status: Operational");
});

test("stale view carries the failure reason and the last verification time", () => {
    const gta = emptyKnowledge("gta", now);
    gta.events.push(event({ key: "gta/weekly-reset/2026-09-17", at: "2026-09-17T10:00:00.000Z", lastVerified: "2026-09-14T06:00:00.000Z" }));
    const view = deriveProviderResult(gtaTopic, gta, { now, outcome: { ok: false, reason: "boom" } }) as any;
    assert.equal(view.status, "stale");
    assert.equal(view.reason, "boom");
    assert.equal(view.last_success_at_utc, "2026-09-14T06:00:00.000Z");
    assert.equal(view.fetched_at_utc, now.toISOString());
    assert.equal(view.nextEventUtc, "2026-09-17T10:00:00.000Z");
});

test("no known event yields the V1 unavailable shape", () => {
    const view = deriveProviderResult(gtaTopic, emptyKnowledge("gta", now), { now, outcome: { ok: true } });
    assert.deepEqual(Object.keys(view), V1_UNAVAILABLE_KEYS);
    assert.equal((view as any).explanation, "No event known for this topic yet");

    const failed = deriveProviderResult(gtaTopic, emptyKnowledge("gta", now), { now, outcome: { ok: false, reason: "offline" } });
    assert.equal((failed as any).explanation, "offline");
});
