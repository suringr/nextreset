/**
 * Publishing V2, milestone 1: the verified value must exist in the served HTML.
 *
 * These run against the real authored page, so template drift fails here rather than in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TrackerData, blocksFor, formatDate, formatDateTime, renderSite, renderTrackerHtml, sourceName, stateLine, trackerOf } from "../../render-pages";

const PAGE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "public", "lol", "next-patch", "index.html"), "utf8");

const PLACEHOLDERS = ["--:--:--", "Checking official sources...", `id="source">...`, `class="confidence">...`];

/** A homepage in the authored shape: cards that say "Loading..." until the build fills them in. */
const HOME = `<html><body><div class="grid" id="game-grid">
      <a href="/lol/next-patch/" class="card" id="card-lol" data-game="lol" data-type="next-patch" data-state="loading" data-next-utc="">
        <div class="card-header">
          <h3 class="card-title">League of Legends</h3>
          <span class="badge badge-unavailable">--</span>
        </div>
        <div class="card-topic">Next patch</div>
        <div class="card-countdown">Loading...</div>
        <div class="card-meta">
          <span class="last-checked">--</span>
        </div>
      </a>

      <a href="/gta/weekly-reset/" class="card" id="card-gta" data-game="gta" data-type="weekly-reset" data-state="loading" data-next-utc="">
        <div class="card-header">
          <h3 class="card-title">GTA Online</h3>
          <span class="badge badge-unavailable">--</span>
        </div>
        <div class="card-topic">Weekly reset</div>
        <div class="card-countdown">Loading...</div>
        <div class="card-meta">
          <span class="last-checked">--</span>
        </div>
      </a>
</div></body></html>`;

const FRESH_DAY: TrackerData = {
    provider_id: "lol", game: "lol", type: "next-patch", title: "League of Legends Next Patch",
    status: "fresh", nextEventUtc: "2026-09-23T00:00:00.000Z",
    fetched_at_utc: "2026-09-16T05:00:00.000Z", last_success_at_utc: "2026-09-16T05:00:00.000Z",
    source_url: "https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends/",
    confidence: "high", notes: "Patch 26.19", precision: "day"
};

const FRESH_EXACT: TrackerData = {
    ...FRESH_DAY, game: "cs2", type: "last-update", status: "fresh",
    nextEventUtc: "2026-09-09T22:51:08.000Z", notes: "Counter-Strike 2 Update", precision: "exact",
    source_url: "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1843481262690556"
};

/** Every dated fixture renders at this instant, so the suite cannot start failing with time. */
const NOW = new Date("2026-09-16T12:00:00Z");

function assertNoPlaceholders(html: string): void {
    for (const p of PLACEHOLDERS) assert.ok(!html.includes(p), `placeholder survived: ${p}`);
}

test("a date-only value is published as a date, with no invented time", () => {
    const html = renderTrackerHtml(PAGE, FRESH_DAY, "page", NOW);
    assert.ok(html.includes("September 23, 2026"), "the verified date is in the HTML");
    assert.ok(html.includes(`<div class="countdown-label">Official date</div>`));
    assert.ok(!html.includes("00:00 UTC"), "midnight is a storage artefact, never shown as a time");
    assert.ok(html.includes("Date only, no time announced"));
    assert.ok(html.includes(`<div id="notes" class="notes">Patch 26.19</div>`), "the version label is published too");
    assertNoPlaceholders(html);
});

test("an exact instant is published to the minute, in UTC", () => {
    const html = renderTrackerHtml(PAGE, FRESH_EXACT, "page", NOW);
    assert.ok(html.includes("September 9, 2026 at 22:51 UTC"));
    assert.ok(html.includes(`<div class="countdown-label">Official date and time</div>`));
    assert.ok(html.includes("Exact time"));
    assertNoPlaceholders(html);
});

test("a value whose precision is not stated is never given a time", () => {
    // The V1 providers (Fortnite, Red Dead) publish no precision at all. Their midnight-UTC instants are
    // a storage artefact, so the page shows a date and claims nothing about the time of day.
    const v1: TrackerData = { ...FRESH_DAY, game: "fortnite", type: "next-season", precision: undefined, nextEventUtc: "2026-11-01T00:00:00.000Z", notes: undefined };
    const html = renderTrackerHtml(PAGE, v1, "page", NOW);
    assert.ok(html.includes("November 1, 2026"));
    assert.ok(!html.includes("00:00 UTC"), "an unstated precision must not become an invented midnight time");
    assert.ok(html.includes(`<div class="countdown-label">Official date</div>`));
    assert.ok(!html.includes("Exact time"), "and no precision is claimed in the info panel");
    assertNoPlaceholders(html);
});

test("the official source is a named link, and freshness is a real timestamp", () => {
    const html = renderTrackerHtml(PAGE, FRESH_DAY, "page", NOW);
    assert.ok(html.includes(`<a href="https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends/" target="_blank" rel="noopener">Riot Games</a>`));
    assert.ok(html.includes("Last Verified"));
    assert.ok(html.includes("September 16, 2026 at 05:00 UTC"));
    assert.ok(html.includes("Verified from the official source"));
});

test("last verified and last checked are separate facts, so a failed refresh cannot relabel an old value", () => {
    const stale: TrackerData = {
        ...FRESH_DAY, status: "stale", reason_code: "source-unreachable", reason: "The official source could not be reached",
        last_success_at_utc: "2026-04-05T21:30:13.065Z", fetched_at_utc: "2026-09-16T19:00:00.000Z"
    };
    const html = renderTrackerHtml(PAGE, stale, "page", NOW);
    assert.ok(html.includes(`<span class="info-value" id="last-verified">April 5, 2026 at 21:30 UTC</span>`), "the verified row holds the last success");
    assert.ok(html.includes(`<span class="info-value" id="last-updated">September 16, 2026 at 19:00 UTC</span>`), "the checked row holds the latest attempt");
    // app.js rewrites #last-updated from fetched_at_utc on load. Only the "checked" row carries that id,
    // so hydration cannot turn a value verified in April into one verified just now.
    assert.ok(!/id="last-verified"[^>]*>September 16/.test(html), "hydration cannot reach the verified row");
    assert.ok(html.includes(`<span class="info-label">Last Checked</span>`));
});

test("a tracker with no successful verification says Never rather than borrowing the attempt time", () => {
    const never: TrackerData = {
        game: "genshin", type: "next-banner", status: "unavailable", nextEventUtc: null,
        fetched_at_utc: "2026-09-16T19:00:00.000Z", explanation: "The official source could not be reached", reason_code: "source-unreachable"
    };
    const html = renderTrackerHtml(PAGE, never, "page", NOW);
    assert.ok(html.includes(`<span class="info-value" id="last-verified">Never</span>`));
    assert.ok(html.includes(`<span class="info-value" id="last-updated">September 16, 2026 at 19:00 UTC</span>`));
});

test("a stale value is still published, with an honest state", () => {
    const stale: TrackerData = { ...FRESH_DAY, status: "stale", reason: "The official source could not be reached", reason_code: "source-unreachable" };
    const html = renderTrackerHtml(PAGE, stale, "page", NOW);
    assert.ok(html.includes("September 23, 2026"), "the last verified value is still shown");
    assert.ok(html.includes("The official source could not be reached"));
    assert.ok(html.includes(`class="countdown-value stale"`));
    assertNoPlaceholders(html);
});

test("a raw provider message is never published, whichever engine produced it", () => {
    // A V1 provider that is stale but backward-looking, so the unanswered rule does not apply and this
    // isolates the one question: can a provider's own message reach a visitor? (Fortnite's passed-date
    // behaviour is covered in honest-states.test.ts.)
    const v1: TrackerData = {
        game: "red-dead-redemption-2", type: "last-update", status: "stale", nextEventUtc: "2026-09-01T00:00:00.000Z",
        last_success_at_utc: "2026-04-05T21:30:13.065Z", source_url: "https://www.rockstargames.com/newswire", confidence: "high",
        reason: "Crashed: Fetch failed: undefined (Status: 403)"
    };
    const html = renderTrackerHtml(PAGE, v1, "page", NOW);
    assert.ok(!html.includes("Crashed"), "no crash string reaches a visitor");
    assert.ok(!html.includes("403"));
    assert.ok(!html.includes("undefined"));
    assert.ok(html.includes("Showing the last verified value"), "it says what happened, in plain words");
});

test("an unavailable tracker invents nothing", () => {
    const unavailable: TrackerData = {
        game: "genshin", type: "next-banner", status: "unavailable", nextEventUtc: null,
        explanation: "The official source could not be reached", reason_code: "source-unreachable",
        fetched_at_utc: "2026-09-16T05:00:00.000Z"
    };
    const html = renderTrackerHtml(PAGE, unavailable, "page", NOW);
    assert.ok(html.includes("Data unavailable"));
    assert.ok(html.includes("The official source could not be reached"));
    assert.ok(!/\b20\d\d\b\s*(at|<)/.test(html.split("countdown-box")[1].slice(0, 400)), "no date is rendered as the value");
    assertNoPlaceholders(html);
});

test("a missing data file publishes an honest unavailable state, never a placeholder", () => {
    const html = renderTrackerHtml(PAGE, undefined, "page", NOW);
    assert.ok(html.includes("Data unavailable"));
    assert.ok(html.includes("No verified value is available right now"));
    assertNoPlaceholders(html);
});

test("rendering changes nothing about the page's identity", () => {
    const html = renderTrackerHtml(PAGE, FRESH_DAY, "page", NOW);
    for (const kept of [
        `<link rel="canonical" href="https://nextreset.co/lol/next-patch/">`,
        `id="countdown-container" data-game="lol" data-type="next-patch"`,
        `<script src="/assets/app.js" defer></script>`,
        `<h1 class="game-title" id="event-title">League of Legends Next Patch</h1>`
    ]) {
        assert.ok(html.includes(kept), `must be preserved: ${kept.slice(0, 50)}`);
    }
    assert.equal(trackerOf(html)?.game, "lol");
    assert.equal(trackerOf(html)?.type, "next-patch");
});

test("values from data are escaped, never injected as markup", () => {
    const nasty: TrackerData = { ...FRESH_DAY, notes: `<script>alert("x")</script>`, confidence: `high" onload="x` };
    const html = renderTrackerHtml(PAGE, nasty, "page", NOW);
    assert.ok(!html.includes("<script>alert"), "notes cannot introduce a script tag");
    assert.ok(html.includes("&lt;script&gt;alert"));
    assert.ok(!html.includes(`onload="x`));
});

test("renderSite writes only HTML, leaves the data files byte-identical, and covers every tracker page", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-dist-"));
    fs.mkdirSync(path.join(dist, "lol", "next-patch"), { recursive: true });
    fs.mkdirSync(path.join(dist, "gta", "weekly-reset"), { recursive: true });
    fs.mkdirSync(path.join(dist, "data"), { recursive: true });
    fs.writeFileSync(path.join(dist, "lol", "next-patch", "index.html"), PAGE);
    fs.writeFileSync(path.join(dist, "gta", "weekly-reset", "index.html"), PAGE.replace(`data-game="lol" data-type="next-patch"`, `data-game="gta" data-type="weekly-reset"`));
    // The homepage has no tracker of its own; it shows every tracker's card.
    fs.writeFileSync(path.join(dist, "index.html"), HOME);
    const dataFile = path.join(dist, "data", "lol.next-patch.json");
    const dataJson = JSON.stringify(FRESH_DAY, null, 2);
    fs.writeFileSync(dataFile, dataJson);

    const summary = renderSite(dist, NOW);

    assert.equal(summary.rendered.length, 2, "both tracker pages rendered");
    assert.equal(summary.skipped, 0, "the homepage is rendered too, not skipped");
    assert.deepEqual(summary.home, { upcoming: 1, recent: 0, unknown: 1 }, "and its cards are grouped by what the data says");
    assert.deepEqual(summary.missingData, ["gta/weekly-reset/index.html"], "the page with no data is reported");
    assert.equal(fs.readFileSync(dataFile, "utf8"), dataJson, "the published JSON contract is untouched");

    const lol = fs.readFileSync(path.join(dist, "lol", "next-patch", "index.html"), "utf8");
    assert.ok(lol.includes("September 23, 2026"));
    assertNoPlaceholders(lol);
    const gta = fs.readFileSync(path.join(dist, "gta", "weekly-reset", "index.html"), "utf8");
    assert.ok(gta.includes("Data unavailable"), "a page without data says so rather than showing --:--:--");
    assertNoPlaceholders(gta);
    const home = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    assert.ok(home.includes("September 23, 2026"), "the homepage carries the value, not a placeholder");
    assert.ok(!home.includes("Loading..."), "and nothing is left loading");

    fs.rmSync(dist, { recursive: true, force: true });
});

test("the tracker container is recognised however its attributes are written", () => {
    const container = `id="countdown-container" data-game="lol" data-type="next-patch"`;
    assert.deepEqual(trackerOf(PAGE), { game: "lol", type: "next-patch" });
    assert.deepEqual(trackerOf(PAGE.replace(container, `data-type="next-patch" id="countdown-container" data-game="lol"`)), { game: "lol", type: "next-patch" }, "order must not matter");
    assert.deepEqual(trackerOf(PAGE.replace(container, `id="countdown-container" class="hidden" data-game="lol" hidden data-type="next-patch"`)), { game: "lol", type: "next-patch" }, "other attributes must not matter");
    assert.deepEqual(trackerOf(PAGE.replace(container, `id = 'countdown-container' data-game='lol' data-type='next-patch'`)), { game: "lol", type: "next-patch" }, "quote style and spacing must not matter");
    assert.equal(trackerOf("<html><body>no tracker here</body></html>"), undefined, "a page without a container is legitimately skipped");
});

test("a tracker container that cannot be read fails the build instead of publishing placeholders", () => {
    const broken = PAGE.replace(` data-type="next-patch"`, "");
    assert.throws(() => trackerOf(broken, "lol/next-patch"), /no readable data-game\/data-type/);
});

test("a slot the page no longer has fails the build instead of publishing a half-rendered page", () => {
    // Drift that matters: the element the value is written into is gone, so rendering would silently
    // publish a page with no value on it.
    const drifted = PAGE.replace(`<div class="countdown-value countdown-skeleton">--:--:--</div>`, `<p>tbd</p>`);
    assert.throws(() => renderTrackerHtml(drifted, FRESH_DAY, "lol/next-patch", NOW), /expected exactly one "answer-value" slot/);
});

test("a slot the page has twice fails the build rather than the renderer guessing", () => {
    const duplicated = PAGE.replace(
        `<div class="countdown-value countdown-skeleton">--:--:--</div>`,
        `<div class="countdown-value countdown-skeleton">--:--:--</div><div class="countdown-value">--:--:--</div>`
    );
    assert.throws(() => renderTrackerHtml(duplicated, FRESH_DAY, "lol/next-patch", NOW), /expected exactly one "answer-value" slot/);
});

test("rewording or reformatting a placeholder is not drift", () => {
    // What the renderer needs is the element, not the words inside it. Before the slots existed, every
    // one of these edits broke the build, which is why the pages could not be redesigned.
    const reworded = PAGE
        .replace(`<div class="countdown-label">Checking official sources...</div>`, `<div class="countdown-label">Loading</div>`)
        .replace(`<div class="countdown-value countdown-skeleton">--:--:--</div>`, `<div class="countdown-skeleton countdown-value">please wait</div>`)
        .replace(`<span class="info-value" id="source">...</span>`, `<span id="source" class="info-value">unknown</span>`)
        .replace(`<span id="confidence" class="confidence">...</span>`, `<span  class='confidence'  id='confidence'>-</span>`);

    const html = renderTrackerHtml(reworded, FRESH_DAY, "lol/next-patch", NOW);
    assert.ok(html.includes("September 23, 2026"), "the verified value is still published");
    assert.ok(html.includes(`<div class="countdown-label">Official date</div>`));
    assert.ok(html.includes(`id="source"`) && html.includes("Riot Games"), "the source is still attributed");
    assert.ok(html.includes(`confidence-high`), "the confidence is still rendered");
    assert.ok(!html.includes("please wait") && !html.includes("unknown"), "no placeholder survived");
});

test("a page that declares its slots is rendered through them, whatever else the markup says", () => {
    // The V4 templates say what each element is. A declared slot wins over the structural fallback, so
    // a redesign can move the value into an element that looks nothing like a countdown box.
    const declared = PAGE.replace(
        `<div class="countdown-value countdown-skeleton">--:--:--</div>`,
        `<output data-nr-slot="answer-value">--:--:--</output>`
    );
    const html = renderTrackerHtml(declared, FRESH_DAY, "lol/next-patch", NOW);
    assert.ok(html.includes("September 23, 2026"), "the declared slot received the value");
    assert.ok(!html.includes("--:--:--"), "the placeholder is gone");
});

test("formatting and source naming are deterministic", () => {
    assert.equal(formatDate("2026-09-23T00:00:00.000Z"), "September 23, 2026");
    assert.equal(formatDateTime("2026-09-09T22:51:08.000Z"), "September 9, 2026 at 22:51 UTC");
    assert.equal(formatDate("not a date"), "");
    assert.equal(sourceName("https://support.riotgames.com/x"), "Riot Games");
    assert.equal(sourceName("https://steamstore-a.akamaihd.net/y"), "Steam");
    assert.equal(sourceName("https://example.org/z"), "example.org");
    assert.equal(sourceName("nonsense"), "Official source");

    assert.equal(stateLine(undefined), "No verified value is available right now");
    assert.equal(blocksFor(FRESH_EXACT, NOW).precision, "Exact time");
    assert.equal(blocksFor({ ...FRESH_DAY, precision: undefined }, NOW).precision, undefined, "an unknown precision is not claimed");
});
