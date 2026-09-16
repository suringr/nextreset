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

    // With no stated precision a value keeps its whole announced day, so "just passed" is judged at the
    // end of that day rather than at the instant (see the day-precision test below).
    const justPassedUnstated: TrackerData = { ...FORTNITE, status: "stale", nextEventUtc: "2026-09-16T11:30:00.000Z" };
    assert.equal(isUnanswered(justPassedUnstated, NOW), false, "an unstated precision keeps its day");

    const justPassedExact: TrackerData = { ...FORTNITE, status: "stale", precision: "exact", nextEventUtc: "2026-09-16T11:30:00.000Z" };
    assert.equal(isUnanswered(justPassedExact, NOW), true, "an exact instant, stale and past, is not an answer");
});

test("a date-only value stays the answer for the whole day it names", () => {
    // LoL's patch date is announced as a day; midnight is only where it had to be stored. A failed
    // check that morning must not replace "September 23, 2026" with "no date announced".
    const patch: TrackerData = {
        game: "lol", type: "next-patch", status: "stale", nextEventUtc: "2026-09-23T00:00:00.000Z",
        precision: "day", fetched_at_utc: "2026-09-23T09:00:00.000Z", last_success_at_utc: "2026-09-22T06:00:00.000Z",
        source_url: "https://support.riotgames.com/x", confidence: "high", notes: "Patch 26.19",
        reason: "The official source could not be reached", reason_code: "source-unreachable"
    };
    const morningOfTheDay = new Date("2026-09-23T09:00:00Z");
    assert.equal(isUnanswered(patch, morningOfTheDay), false, "still the announced day");
    assert.ok(renderTrackerHtml(PAGE, patch, "lol/next-patch", morningOfTheDay).includes("September 23, 2026"));

    const lateThatNight = new Date("2026-09-23T23:59:00Z");
    assert.equal(isUnanswered(patch, lateThatNight), false, "the day is not over yet");

    const nextDay = new Date("2026-09-24T01:00:00Z");
    assert.equal(isUnanswered(patch, nextDay), true, "the announced day has passed without re-verification");
    assert.ok(renderTrackerHtml(PAGE, patch, "lol/next-patch", nextDay).includes("No official date announced"));
});

test("an exact instant is passed the moment it passes", () => {
    const reset: TrackerData = {
        game: "gta", type: "weekly-reset", status: "stale", nextEventUtc: "2026-09-17T10:00:00.000Z",
        precision: "exact", fetched_at_utc: "2026-09-17T11:00:00.000Z", confidence: "high"
    };
    assert.equal(isUnanswered(reset, new Date("2026-09-17T09:59:00Z")), false);
    assert.equal(isUnanswered(reset, new Date("2026-09-17T10:01:00Z")), true, "an exact instant gets no extra day");
});

test("an unanswered tracker reports no confidence, because the stored one described the hidden value", () => {
    const blocks = blocksFor(FORTNITE, NOW);
    assert.equal(blocks.confidence, undefined, "high confidence described the June date, not this answer");
    const html = renderTrackerHtml(PAGE, FORTNITE, "fortnite/next-season", NOW);
    assert.ok(html.includes(`<span id="confidence" class="confidence confidence-none">none</span>`));
    assert.ok(!html.includes("confidence-high"), "no confidence is claimed beside 'no date announced'");
});

test("when a deadline passes while a tracker page is open, the whole page moves together", () => {
    const el = () => ({ textContent: "", innerHTML: "", className: "", style: { display: "none" } });
    const els: Record<string, ReturnType<typeof el>> = {
        "event-title": el(), "countdown": el(), "source": el(), "confidence": el(),
        "last-updated": el(), "notes": el(), "tracker-status": el()
    };
    app.document = { getElementById: (id: string) => els[id] || null };

    app.updateCountdown(FORTNITE);

    assert.match(els["countdown"].innerHTML, /No official date announced/);
    assert.equal(els["notes"].textContent, NO_DATE_NOTE, "the note agrees with the countdown");
    assert.equal(els["tracker-status"].textContent, "No verified official date", "and so does the status row");
    assert.equal(els["confidence"].textContent, "none", "and no confidence is claimed");
    assert.ok(!els["countdown"].innerHTML.includes("stale"), "an unanswered value is not styled as a stale value");
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

test("a homepage card never counts time since an expired date", () => {
    const els: Record<string, { textContent: string; innerHTML: string; className: string }> = {
        ".badge": { textContent: "", innerHTML: "", className: "" },
        ".card-countdown": { textContent: "", innerHTML: "", className: "" },
        ".last-checked": { textContent: "", innerHTML: "", className: "" }
    };
    const card = { dataset: {} as Record<string, string>, querySelector: (sel: string) => els[sel] };

    app.renderCard(card, FORTNITE);
    assert.equal(els[".card-countdown"].textContent, "No official date announced");
    assert.equal(els[".badge"].textContent, "NO DATE", "and it is not badged LIVE");
    assert.equal(card.dataset.unanswered, "1", "so the 60-second updater leaves it alone");

    // A tracker with a real upcoming date still behaves as before. The countdown branch writes
    // innerHTML rather than textContent, so the stub is cleared before comparing.
    els[".card-countdown"].textContent = "";
    els[".card-countdown"].innerHTML = "";
    // renderCard reads the real clock, so this fixture is relative: always 30 days ahead of
    // whenever the suite runs, and therefore always genuinely upcoming.
    const upcoming = { ...FORTNITE, status: "fresh", nextEventUtc: new Date(Date.now() + 30 * 86400000).toISOString() };
    app.renderCard(card, upcoming);
    assert.equal(els[".card-countdown"].textContent, "", "not the unanswered text");
    assert.match(els[".card-countdown"].innerHTML, /unit/, "a real countdown is rendered instead");
    assert.equal(card.dataset.unanswered, "");
});

test("a card whose deadline passes while the page is open becomes NO DATE without a reload", () => {
    const els: Record<string, { textContent: string; innerHTML: string; className: string }> = {
        ".badge": { textContent: "STALE", innerHTML: "", className: "badge badge-stale" },
        ".card-countdown": { textContent: "", innerHTML: "2d 04h", className: "" }
    };
    // A card rendered before its deadline: the dataset says "answered", as renderCard left it.
    const card = {
        dataset: { nextUtc: "2026-06-06T00:00:00.000Z", type: "next-season", precision: "", status: "stale", unanswered: "" } as Record<string, string>,
        querySelector: (sel: string) => els[sel]
    };
    app.document = { querySelectorAll: () => [card] };

    app.updateHomepageCountdowns();

    assert.equal(card.dataset.unanswered, "1", "the updater noticed the deadline had passed");
    assert.equal(els[".card-countdown"].textContent, "No official date announced");
    assert.equal(els[".badge"].textContent, "NO DATE");
    assert.equal(card.dataset.state, "unavailable");
});

/** The handful of elements a tracker page gives updateCountdown, with nothing else on the page. */
function stubPage(...ids: string[]): Record<string, any> {
    const els: Record<string, any> = {};
    for (const id of ids) els[id] = { textContent: "", innerText: "", innerHTML: "", className: "", style: {} };
    app.document = { getElementById: (id: string) => els[id] ?? null };
    return els;
}

test("the browser repairs a run-together note instead of restoring the raw one", () => {
    const RAW = "Red Dead OnlineSeptember 1, 2026Distill Your Best Swill for Triple Rewards";
    const REPAIRED = "Red Dead Online September 1, 2026 Distill Your Best Swill for Triple Rewards";
    assert.equal(app.tidyNotes(RAW), REPAIRED);
    for (const untouched of ["Patch 26.19", "EA SPORTS FC 26 version 1.6.5", "Current status: Operational"]) {
        assert.equal(app.tidyNotes(untouched), untouched);
    }

    // The build renders the repaired note, then app.js fetches the same JSON and writes the note again.
    // It has to arrive repaired here, or hydration quietly restores what the build cleaned up.
    const els = stubPage("event-title", "countdown", "source", "confidence", "last-updated", "notes");
    app.updateCountdown({
        game: "red-dead-redemption-2", type: "last-update", title: "Red Dead Online", status: "fresh",
        nextEventUtc: "2026-08-31T00:00:00.000Z", precision: "day", fetched_at_utc: NOW.toISOString(),
        last_success_at_utc: NOW.toISOString(), source_url: "https://www.rockstargames.com/newswire",
        confidence: "high", notes: RAW
    });
    assert.equal(els.notes.innerText, REPAIRED);
});

test("the browser never publishes a predicted date", () => {
    const source = fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8");
    assert.ok(!source.includes("nextSeasonEstimate"), "a V1 provider's guess is not ours to publish");
    assert.ok(!source.includes("Likely "), "and nothing else predicts a date either");
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

test("no page promises a fixed check frequency the schedule does not keep", () => {
    // Phrase-based rather than exact-string: the promise appeared in five different sentences, and a
    // sixth wording must fail this test too.
    const frequency = /\b(every\s+)?(6|six)\s+hours?\b/i;
    const pages: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) pages.push(full);
        }
    };
    walk(path.join(ROOT, "public"));
    for (const page of pages) {
        const text = fs.readFileSync(page, "utf8");
        assert.ok(!frequency.test(text), `${path.relative(ROOT, page)} still promises a fixed frequency`);
    }
    const generator = fs.readFileSync(path.join(ROOT, "scripts", "update-game-pages.ts"), "utf8");
    assert.ok(!frequency.test(generator), "the generator would reintroduce the promise");
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
