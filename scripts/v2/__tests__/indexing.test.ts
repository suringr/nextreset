/**
 * Publishing V2, milestone 7: which pages ask to be indexed.
 *
 * A tracker page exists to answer one question, and the site was asking Google to index every page
 * whether or not it could. Fortnite's page — three months of a date that had already passed, then an
 * honest "no official date announced" — was in the sitemap the whole time, which is submitting the page
 * that says the least as evidence of what the site is.
 *
 * The rule is the one the renderer already applies to the headline, so the tag and the page can never
 * disagree; and the sitemap follows it, so the site never asks for indexing and refuses it at once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { NOINDEX_TAG, declaresNoindex, indexStateFor, staticPageDecision } from "../../indexing";
import { cardValue } from "../../render-home";
import { TrackerData, blocksFor, renderSite, renderTrackerHtml, stateLine } from "../../render-pages";

const ROOT = path.join(__dirname, "..", "..", "..");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "lol", "next-patch", "index.html"), "utf8");
const NOW = new Date("2026-09-16T12:00:00Z");

/** The published app.js, so "unavailable" can be compared across the build and the browser. */
const app: Record<string, any> = (() => {
    const context: Record<string, any> = { console, setInterval: () => 0, clearTimeout: () => undefined, setTimeout: () => 0 };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8"), context, { filename: "app.js" });
    return context;
})();

const ANSWERED: TrackerData = {
    game: "lol", type: "next-patch", title: "League of Legends", status: "fresh",
    nextEventUtc: "2026-09-23T00:00:00.000Z", precision: "day",
    fetched_at_utc: "2026-09-16T11:00:00.000Z", last_success_at_utc: "2026-09-16T11:00:00.000Z",
    source_url: "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/360018987893", confidence: "high"
};

/** Fortnite as it really was: a June date, still published in September, on a crashed V1 provider. */
const UNANSWERED: TrackerData = {
    game: "fortnite", type: "next-season", title: "Fortnite Season End", status: "stale",
    nextEventUtc: "2026-06-06T00:00:00.000Z",
    fetched_at_utc: "2026-09-16T11:00:00.000Z", last_success_at_utc: "2026-04-05T21:30:13.065Z",
    source_url: "https://www.fortnite.com/", confidence: "high"
};

test("a page that answers its question is the one asking to be indexed", () => {
    assert.deepEqual(indexStateFor(ANSWERED, NOW), { state: "index", reason: "publishes a verified value" });

    const expired = indexStateFor(UNANSWERED, NOW);
    assert.equal(expired.state, "noindex");
    assert.match(expired.reason, /no answer/);

    for (const [name, data] of [
        ["no file at all", undefined],
        ["nothing published", { ...ANSWERED, status: "unavailable" }],
        ["no value", { ...ANSWERED, nextEventUtc: null }]
    ] as Array<[string, TrackerData | undefined]>) {
        assert.equal(indexStateFor(data, NOW).state, "noindex", name);
    }
});

test("a value the pipeline has withdrawn is unavailable everywhere, and asks for nothing", () => {
    // Two ways the pipeline withdraws a value it once published. The tracker page used to miss both:
    // the build rendered the date as a fact, and a moment later the browser replaced it with "Data
    // unavailable" — while the homepage card had already said so and the sitemap still listed it.
    for (const withdrawn of [
        { ...ANSWERED, confidence: "none" },
        { ...ANSWERED, status: "fallback" }
    ]) {
        assert.equal(indexStateFor(withdrawn, NOW).state, "noindex", "not submitted for indexing");
        assert.equal(blocksFor(withdrawn, NOW).value, "Data unavailable", "the tracker page says so");
        assert.equal(cardValue(withdrawn, NOW).value, "Data unavailable", "the homepage card agrees");
        assert.equal(app.isDataUnavailable(withdrawn), true, "and so does the browser");

        const html = renderTrackerHtml(PAGE, withdrawn, "lol/next-patch", NOW);
        assert.ok(html.includes(NOINDEX_TAG), "the page carries the tag");
        assert.ok(!html.includes("September 23, 2026"), "and never shows the withdrawn date");
    }
});

test("a withdrawn value takes the rest of the page with it", () => {
    // The store still holds next month's patches. Listing them under "Data unavailable" would be the
    // page contradicting itself in two directions at once: no value, and here are the values.
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-withdrawn-"));
    fs.mkdirSync(path.join(dist, "lol", "next-patch"), { recursive: true });
    fs.mkdirSync(path.join(dist, "data"), { recursive: true });
    fs.mkdirSync(path.join(dist, "knowledge", "games"), { recursive: true });
    fs.writeFileSync(path.join(dist, "lol", "next-patch", "index.html"), PAGE);
    fs.writeFileSync(path.join(dist, "data", "lol.next-patch.json"), JSON.stringify({ ...ANSWERED, confidence: "none" }));
    fs.writeFileSync(path.join(dist, "knowledge", "games", "lol.json"), JSON.stringify({
        schemaVersion: 1,
        game: "lol",
        updatedAt: "2026-09-15T20:04:34.116Z",
        events: [
            { key: "lol/next-patch/26.19", game: "lol", topic: "next-patch", kind: "version", label: "26.19", status: "scheduled", at: "2026-09-23T00:00:00.000Z", precision: "day", firstSeen: "2026-09-15T20:04:34.116Z", lastVerified: "2026-09-15T20:04:34.116Z", publishState: "published" },
            { key: "lol/next-patch/26.20", game: "lol", topic: "next-patch", kind: "version", label: "26.20", status: "scheduled", at: "2026-10-07T00:00:00.000Z", precision: "day", firstSeen: "2026-09-15T20:04:34.116Z", lastVerified: "2026-09-15T20:04:34.116Z", publishState: "published" }
        ],
        changes: [], overrides: [], documents: [], claims: [], sources: [], discovered: [], topicStates: []
    }));

    renderSite(dist, NOW, dist);

    const html = fs.readFileSync(path.join(dist, "lol", "next-patch", "index.html"), "utf8");
    assert.ok(html.includes("Data unavailable"), "the headline says nothing is published");
    assert.ok(!html.includes("Also scheduled"), "so nothing schedules dates beneath it");
    assert.ok(!html.includes("26.20"), "and no future patch is listed");
    assert.ok(html.includes(NOINDEX_TAG), "and the page is not submitted");

    fs.rmSync(dist, { recursive: true, force: true });
});

test("a timestamp nothing can parse is not a value, and not a page worth indexing", () => {
    // dist/data/*.json is input, not a contract: readData parses JSON and trusts the shape. An
    // unparsable date formats as an empty string, so the page would have published a blank value.
    for (const broken of ["not a date", "2026-13-45T99:99:99Z", ""]) {
        const data = { ...ANSWERED, nextEventUtc: broken };
        assert.equal(indexStateFor(data, NOW).state, "noindex", broken || "(empty)");
        assert.equal(blocksFor(data, NOW).value, "Data unavailable");
        assert.equal(cardValue(data, NOW).value, "Data unavailable");
        assert.equal(app.isDataUnavailable(data), true, "the browser agrees");

        const html = renderTrackerHtml(PAGE, data, "lol/next-patch", NOW);
        assert.ok(html.includes(NOINDEX_TAG));
        assert.ok(!/<div class="countdown-value[^"]*"><\/div>/.test(html), "and no empty value is published");
    }
});

test("a rejected payload never claims to be showing a verified value", () => {
    // Rejected and stale at once: a value the pipeline withdrew, or one whose date cannot be parsed,
    // on a tracker whose source was also unreachable. Asking "is it stale?" before "is there a value?"
    // put "Showing the last verified value" directly beneath "Data Unavailable".
    for (const rejected of [
        { ...ANSWERED, status: "stale", confidence: "none" },
        { ...ANSWERED, status: "stale", nextEventUtc: "not a date" },
        { ...ANSWERED, status: "fallback" }
    ]) {
        assert.equal(app.publicStateNote(rejected), "No verified value is available right now", JSON.stringify(rejected.status + "/" + rejected.confidence));
        assert.equal(stateLine(rejected), "No verified value is available right now", "and the build says the same");
    }

    // A stale payload that does have a value is still described as stale, in both.
    const stale = { ...ANSWERED, status: "stale" };
    assert.equal(app.publicStateNote(stale), "Showing the last verified value; the official source could not be checked");
    assert.equal(stateLine(stale), app.publicStateNote(stale));
});

test("a date that has only just passed is still an answer, and still indexed", () => {
    // The grace period the renderer already applies: the next value arrives with the next refresh, and
    // a tracker must not drop out of the index for the few hours in between.
    const justPassed: TrackerData = { ...ANSWERED, type: "weekly-reset", precision: "exact", nextEventUtc: "2026-09-16T10:00:00.000Z" };
    assert.equal(indexStateFor(justPassed, NOW).state, "index");
});

test("the tag says what the page says, in the head, once", () => {
    const unanswered = renderTrackerHtml(PAGE, UNANSWERED, "fortnite/next-season", NOW);
    const $ = cheerio.load(unanswered);
    assert.equal($(`meta[name="robots"]`).attr("content"), "noindex, follow", "crawled and followed, just not listed");
    assert.equal($("head").find(`meta[name="robots"]`).length, 1, "in the head, exactly once");
    assert.ok($(`link[rel="canonical"]`).length === 1, "and the canonical it sits after is still there");
    assert.ok(unanswered.includes("No official date announced"), "the page still tells a reader what it knows");
    assert.ok(!unanswered.includes("noindex: "), "and never why it was judged");

    const answered = renderTrackerHtml(PAGE, ANSWERED, "lol/next-patch", NOW);
    assert.equal(cheerio.load(answered)(`meta[name="robots"]`).length, 0, "a page with a value asks for nothing");
});

test("a page asking not to be indexed is heard however the tag is written", () => {
    // Attribute order, quoting and spacing are the author's choice, and an ordinary edit or formatter
    // can change all three. Missing the tag would put the page back in the sitemap while it asks to
    // stay out — the contradiction this rule exists to prevent.
    for (const tag of [
        `<meta name="robots" content="noindex, follow">`,
        `<meta content="noindex, follow" name="robots">`,
        `<meta name='robots' content='noindex'>`,
        `<meta   name = "robots"   content = "noindex, nofollow" >`,
        `<meta name="ROBOTS" content="NOINDEX">`,
        `<meta name="robots" content="none">`,
        `<meta name="robots" content="NONE">`,
        `<meta name="robots" content="max-snippet:-1, none">`
    ]) {
        assert.equal(declaresNoindex(`<html><head>${tag}</head><body></body></html>`), true, tag);
        assert.equal(staticPageDecision(`<html><head>${tag}</head><body></body></html>`).state, "noindex", tag);
    }

    // Several tags at once: a crawler combines what it finds and obeys the most restrictive, so the
    // build has to read them all rather than the first one it comes across.
    assert.equal(declaresNoindex(`<html><head><meta name="robots" content="index, follow"><meta name="robots" content="noindex"></head><body></body></html>`), true);
    assert.equal(staticPageDecision(`<html><head><meta name="robots" content="index, follow"><meta name="robots" content="noindex"></head><body></body></html>`).state, "noindex");

    for (const tag of [
        ``,
        `<meta name="robots" content="index, follow">`,
        `<meta name="robots" content="index"><meta name="robots" content="follow">`,
        `<meta name="googlebot" content="noindex">`,
        `<meta name="description" content="a page about noindex">`,
        `<meta name="robots" content="nonetheless">`
    ]) {
        assert.equal(declaresNoindex(`<html><head>${tag}</head><body></body></html>`), false, tag || "(no tag)");
        assert.equal(staticPageDecision(`<html><head>${tag}</head><body></body></html>`).state, "index", tag || "(no tag)");
    }
});

test("a page with no canonical to anchor to fails the build", () => {
    const drifted = PAGE.replace(/<link rel="canonical"[^>]*>/, "");
    assert.throws(() => renderTrackerHtml(drifted, UNANSWERED, "fortnite/next-season", NOW), /exactly one canonical/);
});

test("the site never asks for indexing and refuses it at the same time", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-index-"));
    fs.mkdirSync(path.join(dist, "lol", "next-patch"), { recursive: true });
    fs.mkdirSync(path.join(dist, "fortnite", "next-season"), { recursive: true });
    fs.mkdirSync(path.join(dist, "data"), { recursive: true });
    fs.writeFileSync(path.join(dist, "lol", "next-patch", "index.html"), PAGE);
    fs.writeFileSync(
        path.join(dist, "fortnite", "next-season", "index.html"),
        PAGE
            .replace(`data-game="lol" data-type="next-patch"`, `data-game="fortnite" data-type="next-season"`)
            .replace(`<link rel="canonical" href="https://nextreset.co/lol/next-patch/">`, `<link rel="canonical" href="https://nextreset.co/fortnite/next-season/">`)
    );
    fs.writeFileSync(path.join(dist, "index.html"), `<html><head><link rel="canonical" href="https://nextreset.co/"></head><body><section data-nr-slot="next-drop"></section><div class="grid" id="game-grid" data-nr-region="cards">
      <a href="/lol/next-patch/" class="card" id="card-lol" data-game="lol" data-type="next-patch" data-state="loading" data-next-utc="">
        <div class="card-header"><h3 class="card-title">League of Legends</h3><span class="badge badge-unavailable">--</span></div>
        <div class="card-topic">Next patch</div>
        <div class="card-countdown">Loading...</div>
        <div class="card-meta"><span class="last-checked">--</span></div>
      </a>
</div></body></html>`);
    fs.writeFileSync(path.join(dist, "data", "lol.next-patch.json"), JSON.stringify(ANSWERED));
    fs.writeFileSync(path.join(dist, "data", "fortnite.next-season.json"), JSON.stringify(UNANSWERED));
    // The 404 page says noindex in its own head. "Has no tracker" must not be read as "index it".
    fs.writeFileSync(path.join(dist, "404.html"), `<html><head><meta name="robots" content="noindex, follow"><title>Not found</title></head><body><h1>Not here</h1></body></html>`);

    const summary = renderSite(dist, NOW, dist);

    const states = Object.fromEntries(summary.indexing.map(entry => [entry.page, entry.state]));
    assert.deepEqual(states, {
        "404.html": "noindex",
        "fortnite/next-season/index.html": "noindex",
        "index.html": "index",
        "lol/next-patch/index.html": "index"
    });

    const locs = summary.sitemap.map(entry => entry.loc);
    assert.deepEqual(locs, ["https://nextreset.co/", "https://nextreset.co/lol/next-patch/"], "the unanswered page is not submitted");

    // The two signals, checked against each other on the files themselves rather than the summary.
    for (const [page, state] of Object.entries(states)) {
        const html = fs.readFileSync(path.join(dist, page), "utf8");
        const tagged = cheerio.load(html)(`meta[name="robots"][content*="noindex"]`).length > 0;
        const listed = locs.some(loc => loc === `https://nextreset.co/${page.replace(/index\.html$/, "")}`);
        assert.equal(tagged, state === "noindex", `${page}: the tag disagrees with the decision`);
        assert.equal(listed, !tagged, `${page}: asking to be indexed and refusing it at once`);
    }

    fs.rmSync(dist, { recursive: true, force: true });
});

test("nothing is disallowed that needs to be read to be obeyed", () => {
    // A noindex tag on a page robots.txt forbids is a tag nobody is allowed to read, so the page stays
    // indexed on its links alone. The tracker pages must therefore remain crawlable.
    const robots = fs.readFileSync(path.join(ROOT, "public", "robots.txt"), "utf8");
    const disallowed = [...robots.matchAll(/^Disallow: (\S+)$/gm)].map(m => m[1]);
    assert.deepEqual(disallowed, ["/data/"], "only the JSON the pages read is kept out");
    assert.ok(!NOINDEX_TAG.includes("nofollow"), "a page that cannot be indexed can still pass a reader on");
});
