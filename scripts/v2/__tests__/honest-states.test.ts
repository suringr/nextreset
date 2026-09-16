/**
 * Publishing V2, milestone 2: the site must not claim more than it knows.
 *
 * Three things are checked here: a future-facing date that has passed is not published as an answer,
 * a provider's own error message never reaches a visitor (server-rendered or hydrated), and the
 * statements the audit proved false are gone from the authored pages and from their generator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { NO_DATE_NOTE, TrackerData, blocksFor, isFutureFacing, isUnanswered, renderTrackerHtml } from "../../render-pages";

const ROOT = path.join(__dirname, "..", "..", "..");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "fortnite", "next-season", "index.html"), "utf8");
const NOW = new Date("2026-09-16T12:00:00Z");

/** Fortnite as it was actually published: a June date, still shown in September, on a V1 provider. */
const FORTNITE: TrackerData = {
    provider_id: "fortnite", game: "fortnite", type: "next-season", title: "Fortnite Season End",
    status: "stale", nextEventUtc: "2026-06-06T00:00:00.000Z",
    fetched_at_utc: "2026-09-16T11:00:00.000Z", last_success_at_utc: "2026-04-05T21:30:13.065Z",
    source_url: "https://www.fortnite.com/", confidence: "high",
    reason: "Crashed: Fetch failed: undefined (Status: 403)"
};

test("a future-facing date that has passed is not published as the answer", () => {
    const html = renderTrackerHtml(PAGE, FORTNITE, "fortnite/next-season", NOW);
    assert.ok(html.includes("No official date announced"));
    assert.ok(html.includes(NO_DATE_NOTE));
    assert.ok(!html.includes("June 6, 2026"), "the passed date is not shown as the value");
    assert.ok(!html.includes("Crashed"), "and the provider's message still never appears");
    assert.ok(html.includes("No verified official date"));
});

test("a date that has only just passed, freshly verified, is still the answer", () => {
    // GTA's reset recomputes on the next run; a few minutes of "just passed" is a normal moment.
    const gta: TrackerData = {
        game: "gta", type: "weekly-reset", status: "fresh", nextEventUtc: "2026-09-16T10:00:00.000Z",
        fetched_at_utc: NOW.toISOString(), last_success_at_utc: NOW.toISOString(), precision: "exact",
        source_url: "https://www.rockstargames.com/gta-online", confidence: "high"
    };
    assert.equal(isUnanswered(gta, NOW), false);
    assert.ok(renderTrackerHtml(PAGE, gta, "gta/weekly-reset", NOW).includes("September 16, 2026 at 10:00 UTC"));
});

test("a past date on a backward-looking tracker is exactly what that tracker is for", () => {
    const cs2: TrackerData = {
        game: "cs2", type: "last-update", status: "fresh", nextEventUtc: "2026-09-09T22:51:08.000Z",
        fetched_at_utc: NOW.toISOString(), last_success_at_utc: NOW.toISOString(), precision: "exact",
        source_url: "https://steamstore-a.akamaihd.net/news/x", confidence: "high"
    };
    assert.equal(isFutureFacing("last-update"), false);
    assert.equal(isUnanswered(cs2, NOW), false);
    assert.ok(renderTrackerHtml(PAGE, cs2, "cs2/last-update", NOW).includes("September 9, 2026 at 22:51 UTC"));
});

test("the unanswered rule is about staleness and age, not about one game", () => {
    assert.equal(isFutureFacing("next-season"), true);
    assert.equal(isFutureFacing("weekly-reset"), true);
    assert.equal(isFutureFacing("next-banner"), true);
    assert.equal(isFutureFacing("last-patch"), false);
    assert.equal(isFutureFacing(undefined), false);

    const future: TrackerData = { ...FORTNITE, status: "fresh", nextEventUtc: "2026-12-01T00:00:00.000Z" };
    assert.equal(isUnanswered(future, NOW), false, "a date still ahead is an answer");

    const longPassedButFresh: TrackerData = { ...FORTNITE, status: "fresh", nextEventUtc: "2026-09-10T00:00:00.000Z" };
    assert.equal(isUnanswered(longPassedButFresh, NOW), true, "days past due is not an answer, however it is labelled");

    const justPassedStale: TrackerData = { ...FORTNITE, status: "stale", nextEventUtc: "2026-09-16T11:30:00.000Z" };
    assert.equal(isUnanswered(justPassedStale, NOW), true, "stale and past means nobody re-verified it");
});

test("the unanswered page still carries its source and verification times", () => {
    const blocks = blocksFor(FORTNITE, NOW);
    assert.equal(blocks.source?.name, "Epic Games");
    assert.equal(blocks.lastVerified, "April 5, 2026 at 21:30 UTC");
    assert.equal(blocks.lastChecked, "September 16, 2026 at 11:00 UTC");
    assert.equal(blocks.precision, undefined, "no precision is claimed for a value we are not showing");
});

/** The published app.js, loaded outside a browser: its decision helpers are pure. */
function loadApp(): Record<string, any> {
    const context: Record<string, any> = { console, setInterval: () => 0, clearTimeout: () => undefined, setTimeout: () => 0 };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8"), context, { filename: "app.js" });
    return context;
}

const app = loadApp();
const NOW_MS = NOW.getTime();

test("the browser reaches the same conclusion as the build, so hydration cannot undo it", () => {
    const display = app.eventDisplay(FORTNITE, NOW_MS);
    assert.deepEqual([display.mode, display.value], ["unanswered", "No official date announced"]);

    const stillAhead = app.eventDisplay({ ...FORTNITE, status: "fresh", nextEventUtc: "2026-12-01T00:00:00.000Z" }, NOW_MS);
    assert.equal(stillAhead.mode, "countdown", "a date still ahead keeps its countdown");
});

test("app.js never shows a provider's own message", () => {
    assert.equal(app.publicStateNote(FORTNITE), "Showing the last verified value; the official source could not be checked");
    assert.ok(!app.publicStateNote(FORTNITE).includes("Crashed"));

    const vetted = { status: "stale", reason: "The official source could not be reached", reason_code: "source-unreachable" };
    assert.equal(app.publicStateNote(vetted), "The official source could not be reached", "a sentence made for visitors is shown as-is");

    const rawUnavailable = { status: "unavailable", explanation: "Crashed (v2): boom" };
    assert.equal(app.publicStateNote(rawUnavailable), "No verified value is available right now");

    const vettedUnavailable = { status: "unavailable", explanation: "The official source could not be reached", reason_code: "source-unreachable" };
    assert.equal(app.publicStateNote(vettedUnavailable), "The official source could not be reached");
});

test("the statements the audit proved false are gone, and cannot come back from the generator", () => {
    const gone = [
        "Every 6 Hours",
        "Automated Monitoring",
        "Data shown below is from the latest check",
        "Data automatically updated every 6 hours from official sources"
    ];
    const pages: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) pages.push(full);
        }
    };
    walk(path.join(ROOT, "public"));
    assert.ok(pages.length >= 15, `expected the authored pages, found ${pages.length}`);

    for (const page of pages) {
        const text = fs.readFileSync(page, "utf8");
        for (const claim of gone) {
            assert.ok(!text.includes(claim), `${path.relative(ROOT, page)} still claims: ${claim}`);
        }
    }

    const generator = fs.readFileSync(path.join(ROOT, "scripts", "update-game-pages.ts"), "utf8");
    for (const claim of gone) {
        assert.ok(!generator.includes(claim), `the generator would reintroduce: ${claim}`);
    }
});

test("the privacy policy describes the site that actually exists", () => {
    const privacy = fs.readFileSync(path.join(ROOT, "public", "privacy", "index.html"), "utf8");

    assert.ok(!privacy.includes("We do not use targeted advertising"), "that claim contradicts ads.txt");
    assert.ok(!privacy.includes("<strong>GitHub Pages</strong> — For hosting the Site"), "the site is served by Cloudflare Pages");

    assert.ok(privacy.includes("Cloudflare Pages"), "the real host is named");
    assert.ok(privacy.includes("Google AdSense"), "the intended advertising is disclosed");
    assert.ok(privacy.includes("may place and read cookies"), "third-party ad cookies are disclosed, as Google requires");
    assert.ok(privacy.includes("policies.google.com/technologies/partner-sites"), "and how Google uses that data is linked");
    assert.ok(privacy.includes("No advertising code is served on the Site today"), "while staying true about today");
    assert.ok(privacy.includes("Google Analytics 4"), "the analytics disclosure is kept");
});
