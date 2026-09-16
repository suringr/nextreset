/**
 * Precision travels from the stored event to the published JSON and decides what the page shows:
 * a date when the official source states only a date, a countdown only when the instant is exact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { Event, emptyKnowledge } from "../domain";
import { findGame, findTopic } from "../games";
import { deriveProviderResult } from "../views";
import { V1_GTA_FRESH_KEYS } from "./helpers";

const gtaTopic = findTopic(findGame("gta"), "weekly-reset");
const lolTopic = findTopic(findGame("lol"), "next-patch");
const now = new Date("2026-09-16T12:00:00Z");

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

const dayPatch = () => {
    const lol = emptyKnowledge("lol", now);
    lol.events.push(event({
        key: "lol/next-patch/26.19", game: "lol", topic: "next-patch", kind: "version",
        label: "26.19", at: "2026-09-23T00:00:00.000Z", precision: "day"
    }));
    return lol;
};

test("the published view states the precision of the instant it publishes", () => {
    const gta = emptyKnowledge("gta", now);
    gta.events.push(event({ key: "gta/weekly-reset/2026-09-17", at: "2026-09-17T10:00:00.000Z" }));
    const exact = deriveProviderResult(gtaTopic, gta, { now, outcome: { ok: true } }) as unknown as Record<string, unknown>;
    assert.equal(exact.precision, "exact");
    assert.deepEqual(Object.keys(exact), [...V1_GTA_FRESH_KEYS, "precision"], "every V1 key keeps its place; precision is appended");

    const day = deriveProviderResult(lolTopic, dayPatch(), { now, outcome: { ok: true } }) as unknown as Record<string, unknown>;
    assert.equal(day.precision, "day");
    assert.equal(day.nextEventUtc, "2026-09-23T00:00:00.000Z", "the stored instant is unchanged; only its precision is now stated");
});

test("a stale view keeps the precision of the value it serves", () => {
    const view = deriveProviderResult(lolTopic, dayPatch(), { now, outcome: { ok: false, reason: "internal detail", kind: "source-unreachable" } }) as unknown as Record<string, unknown>;
    assert.equal(view.status, "stale");
    assert.equal(view.precision, "day");
});

/** The published app.js, loaded outside a browser: its display helpers are pure. */
function loadApp(): Record<string, any> {
    const file = path.join(__dirname, "..", "..", "..", "public", "assets", "app.js");
    const context: Record<string, any> = {
        console,
        setInterval: () => 0,
        clearTimeout: () => undefined,
        setTimeout: () => 0
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: "app.js" });
    return context;
}

const app = loadApp();
const NOW_MS = Date.parse("2026-09-16T12:00:00Z");

test("a day-only value is shown as a date, never as a second-level countdown", () => {
    const display = app.eventDisplay({ nextEventUtc: "2026-09-23T00:00:00.000Z", type: "next-patch", precision: "day" }, NOW_MS);
    assert.deepEqual([display.mode, display.value], ["date", "September 23, 2026"]);
    assert.ok(!/\d\s*<span class="unit">s<\/span>/.test(display.value), "no seconds are invented from a date");
});

test("a past day-only value shows its date rather than a time since", () => {
    const display = app.eventDisplay({ nextEventUtc: "2026-08-28T00:00:00.000Z", type: "last-patch", precision: "day" }, NOW_MS);
    assert.deepEqual([display.mode, display.value], ["date", "August 28, 2026"]);
});

test("an exact instant still counts down, and still counts up once it has passed", () => {
    const future = app.eventDisplay({ nextEventUtc: "2026-09-17T10:00:00.000Z", type: "weekly-reset", precision: "exact" }, NOW_MS);
    assert.equal(future.mode, "countdown");
    assert.equal(future.label, "Time Until Event");
    assert.match(future.value, /<span class="unit">s<\/span>/, "an exact instant keeps second-level detail");

    const past = app.eventDisplay({ nextEventUtc: "2026-09-09T22:51:08.000Z", type: "last-update", precision: "exact" }, NOW_MS);
    assert.deepEqual([past.mode, past.label], ["countdown", "Time Since Event"]);
});

test("an upcoming exact event that has just passed still reads as Updating...", () => {
    const display = app.eventDisplay({ nextEventUtc: "2026-09-16T11:00:00.000Z", type: "next-patch", precision: "exact" }, NOW_MS);
    assert.deepEqual([display.mode, display.value], ["updating", "Updating..."]);
});

test("data with no precision field is a date, because nobody said it was an instant", () => {
    // V1 providers publish no precision. Their midnight is where a date had to be stored, so counting
    // down to it to the second would invent a time — and would contradict the date the build rendered.
    const display = app.eventDisplay({ nextEventUtc: "2026-09-23T00:00:00.000Z", type: "next-season" }, NOW_MS);
    assert.equal(display.mode, "date");
    assert.equal(display.value, "September 23, 2026");

    const exact = app.eventDisplay({ nextEventUtc: "2026-09-23T21:00:00.000Z", type: "next-season", precision: "exact" }, NOW_MS);
    assert.equal(exact.mode, "countdown", "a stated instant still counts down");
});
