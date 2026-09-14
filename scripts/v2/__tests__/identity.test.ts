import test from "node:test";
import assert from "node:assert/strict";
import { IdentityError, dayIdentity, eventKey, instantIdentity, isEventKey, normalizeIdentity, parseEventKey } from "../identity";

test("same logical event produces the same key", () => {
    assert.equal(eventKey("gta", "weekly-reset", "2026-09-17"), eventKey("gta", "weekly-reset", "2026-09-17"));
    assert.equal(eventKey("gta", "weekly-reset", "2026-09-17"), "gta/weekly-reset/2026-09-17");
    // Millisecond and formatting differences of the same instant collapse to one identity.
    assert.equal(instantIdentity("2026-08-07T04:48:28.252Z"), instantIdentity("2026-08-07T04:48:28Z"));
    assert.equal(instantIdentity("2026-08-07T04:48:28.252Z"), "2026-08-07t04-48-28z");
});

test("different occurrences produce different keys", () => {
    assert.notEqual(eventKey("gta", "weekly-reset", "2026-09-17"), eventKey("gta", "weekly-reset", "2026-09-24"));
    assert.notEqual(instantIdentity("2026-08-07T04:48:28Z"), instantIdentity("2026-08-07T04:48:29Z"));
    assert.notEqual(eventKey("gta", "weekly-reset", "x"), eventKey("roblox", "weekly-reset", "x"));
});

test("normalization is deterministic and forgiving about case, spaces and punctuation", () => {
    assert.equal(normalizeIdentity(" Patch 26.19 "), "patch-26.19");
    assert.equal(normalizeIdentity("Season 05: Reloaded"), "season-05-reloaded");
    assert.equal(normalizeIdentity("v37.20"), "v37.20");
    assert.equal(normalizeIdentity("---a--b---"), "a-b");
});

test("invalid identities and segments are rejected", () => {
    assert.throws(() => normalizeIdentity("   "), IdentityError);
    assert.throws(() => normalizeIdentity("!!!"), IdentityError);
    assert.throws(() => eventKey("GTA", "weekly-reset", "2026-09-17"), IdentityError);
    assert.throws(() => eventKey("gta", "weekly reset", "2026-09-17"), IdentityError);
    assert.throws(() => instantIdentity("not a date"), IdentityError);
});

test("day identity uses the UTC calendar day", () => {
    assert.equal(dayIdentity("2026-09-17T10:00:00.000Z"), "2026-09-17");
    assert.equal(dayIdentity("2026-09-17T23:59:59.999Z"), "2026-09-17");
});

test("event keys parse back into their parts", () => {
    assert.deepEqual(parseEventKey("roblox/status/2026-08-07t04-48-28z"), { game: "roblox", topic: "status", identity: "2026-08-07t04-48-28z" });
    assert.equal(isEventKey("gta/weekly-reset/2026-09-17"), true);
    assert.equal(isEventKey("gta/weekly-reset"), false);
    assert.equal(isEventKey("gta/weekly-reset/Bad Identity"), false);
    assert.throws(() => parseEventKey("nope"), IdentityError);
});
