/**
 * V4, PR 9: what must be true of the whole built site, every time.
 *
 * Every other suite checks a module, a page or a rule. This one builds the site the way CI builds it
 * and asks the questions that only have an answer once everything is assembled — the ones a redesign
 * can break without breaking anything smaller.
 *
 * It runs against a real render into a temporary directory, with a pinned clock and the repository's
 * own data, so it exercises the same code path that publishes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { adsenseLoaderCount, carriesLoader, hasAdUnitMarkup } from "../../adsense";
import { declaresNoindex } from "../../indexing";
import { TrackerData, hasVerifiedValue, isUnanswered, renderSite, trackerOf } from "../../render-pages";
import { urlPathOf } from "../../render-sitemap";
import { matchesDirectory, trackerPages as trackerManifest } from "../../site-map";

const ROOT = path.join(__dirname, "..", "..", "..");
const NOW = new Date("2026-09-17T12:00:00.000Z");

/**
 * Fills in any tracker file the checkout does not have from the committed last-known-good vault.
 *
 * `public/data/*.json` is generated and gitignored; only `public/data/_lkg/` is committed. So in CI —
 * a clean checkout, `npm run build && npm test`, no refresh — every tracker file was missing and every
 * value check below skipped itself and passed. The gate never checked a published value in the one
 * place that runs on every pull request. The vault is what the site publishes when a provider fails,
 * so it is a fair fixture; a checkout that already has fresher data keeps it.
 */
function seedFromLastKnownGood(data: string): string[] {
    const vault = path.join(data, "_lkg");
    const seeded: string[] = [];
    if (!fs.existsSync(vault)) return seeded;
    for (const name of fs.readdirSync(vault).filter(f => f.endsWith(".json"))) {
        const target = path.join(data, name);
        if (!fs.existsSync(target)) {
            fs.copyFileSync(path.join(vault, name), target);
            seeded.push(name);
        }
    }
    return seeded;
}

/** Copies a directory tree. */
function copyTree(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, entry.name);
        const b = path.join(to, entry.name);
        if (entry.isDirectory()) copyTree(a, b);
        else fs.copyFileSync(a, b);
    }
}

/** Builds the site into a temporary directory, exactly as export:site + render:pages do. */
function build(): { dir: string; pages: string[]; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-whole-"));
    copyTree(path.join(ROOT, "public"), dir);
    const debug = path.join(dir, "data", "_debug");
    if (fs.existsSync(debug)) fs.rmSync(debug, { recursive: true, force: true });
    seedFromLastKnownGood(path.join(dir, "data"));
    renderSite(dir, NOW, ROOT);

    const pages: string[] = [];
    const walk = (at: string) => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) pages.push(path.relative(dir, full).replace(/\\/g, "/"));
        }
    };
    walk(dir);
    return { dir, pages: pages.sort(), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const site = build();
const read = (page: string) => fs.readFileSync(path.join(site.dir, page), "utf8");
const trackerPages = site.pages.filter(page => trackerOf(read(page), page));

test.after(() => site.cleanup());

test("the build produced every page the site has", () => {
    // Against the manifest rather than a literal, so adding a page is one declarative edit instead of a
    // renumbering exercise across three suites — and so a page that is built but undeclared still fails.
    const { undeclared, missing } = matchesDirectory(site.dir);
    assert.deepEqual(undeclared, [], "the build produced pages scripts/site-map.ts does not declare");
    assert.deepEqual(missing, [], "the build did not produce pages scripts/site-map.ts declares");
    assert.deepEqual(trackerPages.sort(), trackerManifest().map(entry => entry.page).sort(),
        "the pages that read as trackers are not the pages declared as trackers");
});

/** How many tracker pages have data behind them in this build — the number a value check must reach. */
const withData = () => trackerPages.filter(page => {
    const tracker = trackerOf(read(page), page)!;
    return fs.existsSync(path.join(site.dir, "data", `${tracker.game}.${tracker.type}.json`));
}).length;

test("the value checks below have data to check, in CI as well as locally", () => {
    // Codex P2 on #54: without this, a clean checkout skipped every tracker and every value check passed
    // by checking nothing. The committed vault covers nine of the twelve.
    assert.ok(withData() >= 9, `only ${withData()} of ${trackerPages.length} trackers have data in this build`);
});

test("every tracker's published value is in the served HTML, before any script runs", () => {
    // The whole point of Publishing V2. Asked of the built page rather than of the renderer, because
    // this is the file a crawler and a reader without JavaScript actually receive.
    let checked = 0;
    for (const page of trackerPages) {
        const tracker = trackerOf(read(page), page)!;
        const file = path.join(site.dir, "data", `${tracker.game}.${tracker.type}.json`);
        if (!fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as TrackerData;
        const $ = cheerio.load(read(page));
        const headline = $(".countdown-value").first().text().trim();
        assert.ok(headline.length > 0, `${page} publishes no headline`);
        assert.ok(!headline.includes("--:--"), `${page} still shows a placeholder`);
        checked++;

        if (hasVerifiedValue(data) && !isUnanswered(data, NOW)) {
            // A real value, and the year it names is in the page.
            const year = new Date(data.nextEventUtc).getUTCFullYear();
            assert.ok(headline.includes(String(year)), `${page}: headline "${headline}" does not carry the value's year`);
        } else {
            assert.ok(
                /No official date announced|Data unavailable/.test(headline),
                `${page}: no verified value, but the headline reads "${headline}"`
            );
        }
    }
    assert.equal(checked, withData(), "a tracker with data was skipped");
});

test("a time is published only where the pipeline says the instant is exact", () => {
    // The rule the site's credibility rests on, checked across every page at once.
    const seen = { exact: 0, day: 0 };
    for (const page of trackerPages) {
        const tracker = trackerOf(read(page), page)!;
        const file = path.join(site.dir, "data", `${tracker.game}.${tracker.type}.json`);
        if (!fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as TrackerData;
        if (!hasVerifiedValue(data) || isUnanswered(data, NOW)) continue;
        const headline = cheerio.load(read(page))(".countdown-value").first().text().trim();
        if (data.precision === "exact") {
            assert.match(headline, /\d{2}:\d{2} UTC$/, `${page}: an exact instant should publish its time`);
            seen.exact++;
        } else {
            assert.ok(!/\d{2}:\d{2}/.test(headline), `${page}: "${headline}" publishes a time the source never announced`);
            seen.day++;
        }
    }
    // Non-vacuous: at least one verified value went through this rule. Which half depends on the data.
    // The committed vault predates the precision field, so in CI every value is date-only, and the exact
    // half is proven with fixtures in render-pages.test.ts ("an exact instant is published to the minute").
    assert.ok(seen.exact + seen.day > 0, "no tracker with a verified value was checked");
});

test("the sitemap lists exactly the pages that ask to be indexed", () => {
    const xml = fs.readFileSync(path.join(site.dir, "sitemap.xml"), "utf8");
    const listed = [...xml.matchAll(/<loc>https:\/\/nextreset\.co([^<]*)<\/loc>/g)].map(m => m[1]).sort();
    const wanted = site.pages
        .filter(page => page !== "404.html")
        .filter(page => !declaresNoindex(read(page)))
        .map(urlPathOf)
        .sort();
    assert.deepEqual(listed, wanted);
    // And nothing asks for both at once, which is the contradiction that teaches a crawler to ignore both.
    for (const page of site.pages) {
        const url = urlPathOf(page);
        if (declaresNoindex(read(page))) {
            assert.ok(!listed.includes(url), `${page} says noindex and is in the sitemap`);
        }
    }
});

test("every page declares one canonical, at its own location, and one h1", () => {
    for (const page of site.pages) {
        const $ = cheerio.load(read(page));
        const canonical = $('link[rel="canonical"]').attr("href");
        if (page === "404.html") {
            assert.equal($('link[rel="canonical"]').length, 0, "a page that is not a page has no canonical");
        } else {
            assert.equal(canonical, `https://nextreset.co${urlPathOf(page)}`, `${page}: canonical and location disagree`);
        }
        assert.equal($("h1").length, 1, `${page} has ${$("h1").length} h1 elements`);
    }
});

test("the AdSense rule holds across the built site, and no ad unit exists anywhere", () => {
    for (const page of site.pages) {
        const html = read(page);
        assert.equal(adsenseLoaderCount(html), carriesLoader(page) ? 1 : 0, `${page}: wrong loader count`);
        assert.equal(hasAdUnitMarkup(html), false, `${page} carries ad-unit markup`);
        assert.ok(!/__tcfapi|googlefc|fundingchoices/i.test(html), `${page} implements its own consent platform`);
    }
    // The two exclusions, named, so a third cannot appear by accident.
    assert.deepEqual(site.pages.filter(page => !carriesLoader(page)).sort(), ["404.html", "play/index.html"]);
});

test("the arcade is reachable from every page, and the game loads on none of them", () => {
    for (const page of site.pages) {
        const html = read(page);
        assert.ok(html.includes('href="/play/"') || page === "play/index.html", `${page} does not reach the arcade`);
        if (page === "play/index.html") continue;
        assert.ok(!html.includes("one-shot.js"), `${page} loads the game`);
    }
});

test("every asset the pages ask for exists and is versioned", () => {
    // `_headers` caches /assets/* for a year, so an unversioned reference is a year-old file.
    for (const page of site.pages) {
        for (const match of read(page).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
            const [url, query] = match[1].split("?");
            const file = path.join(site.dir, url.replace(/^\//, ""));
            assert.ok(fs.existsSync(file), `${page} references ${url}, which is not in the build`);
            assert.match(query ?? "", /^v=[0-9a-f]{8}$/, `${page}: ${match[1]} is not versioned`);
        }
    }
});

test("the served stylesheet carries no documentation, and the pages carry no placeholder", () => {
    const css = fs.readFileSync(path.join(site.dir, "assets", "styles.v2.css"), "utf8");
    assert.equal((css.match(/\/\*/g) ?? []).length, 0, "comments are not shipped");
    for (const page of site.pages) {
        const html = read(page);
        for (const placeholder of ["--:--:--", "Loading...", "Checking official sources"]) {
            assert.ok(!html.includes(placeholder), `${page} still shows "${placeholder}"`);
        }
    }
});

test("no page promises a check frequency or invents a community", () => {
    for (const page of site.pages) {
        const html = read(page);
        assert.ok(!/every six hours|every 6 hours/i.test(html), `${page} promises a frequency the schedule does not keep`);
        assert.ok(!/\b\d[\d,]*\s+(players|users|members)\b/i.test(html), `${page} claims a population it cannot count`);
        // Codex P2 on #54: this was /leaderboard\b(?!)/, and an empty negative lookahead never matches,
        // so the assertion could not fail. A page may mention a leaderboard only to say there is none.
        assert.ok(!/leaderboard/i.test(html) || /no leaderboard/i.test(html), `${page} implies a leaderboard`);
    }
});

// The Fortnite page told readers its date "is pulled directly from the official Fortnite Battle Pass
// page and updates automatically", in prose and inside FAQPage schema, for the six months after that
// source began answering 403. Promising future automatic behaviour is the same class of claim as
// promising a check frequency, and it is a promise no source lets us keep: any publisher can go dark
// tomorrow exactly as Epic did. A page may say where a value came from; it may not say what will
// happen next.
test("no page promises that it updates itself", () => {
    for (const page of site.pages) {
        const html = read(page);
        for (const promise of [/updates? automatically/i, /updated automatically/i, /always reflects/i]) {
            assert.ok(!promise.test(html), `${page} promises automatic updating, which no source guarantees`);
        }
    }
});

// The same page referred readers to "the countdown above" while displaying no date at all. A page that
// cannot answer its question must not describe an answer it is not showing -- in the document or in the
// structured data, which is the copy that outlives the page in search results.
/** Ways a page can tell a reader that a value is on display. Same claim, different word orders. */
const DESCRIBES_A_VALUE = [
    /countdown above/i,
    /shown in the countdown/i,
    /is shown above/i,
    /is displayed above/i,
    /is shown in the tracker/i,
    /date is shown in the/i,
    // Added after the rewrite introduced its own version of the same claim (Codex, #67). "The date here
    // is X" asserts a date is here just as plainly as "shown above" did, and three of the six answers I
    // wrote to fix the first phrasing had quietly reintroduced it in the second.
    /date here is/i,
    /the date here/i
];

test("no tracker describes a value it is not showing — checked against every one of them", () => {
    // Rendered with no data at all, rather than judged against whichever fixtures happen to be valid.
    //
    // Two weaker versions of this guard shipped before this one. The first skipped trackers whose data
    // file was absent, which is precisely the state it existed to catch. The second fixed that but still
    // only examined trackers that were unanswered *in this build*, so a page with state-dependent prose
    // was excused for as long as its fixture held — and `checked > 0` passed on one unrelated tracker
    // (Codex, #67). The population now is every tracker there is, in the state where the claim is wrong.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-novalue-"));
    try {
        const copy = (from: string, to: string) => {
            fs.mkdirSync(to, { recursive: true });
            for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
                const a = path.join(from, entry.name);
                const b = path.join(to, entry.name);
                if (entry.isDirectory()) copy(a, b);
                else fs.copyFileSync(a, b);
            }
        };
        copy(path.join(ROOT, "public"), dir);
        // Every tracker unanswered at once: no live data, and no vault to fall back to.
        fs.rmSync(path.join(dir, "data"), { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, "data"), { recursive: true });
        renderSite(dir, NOW, ROOT);

        const exercised: string[] = [];
        for (const entry of trackerManifest()) {
            const html = fs.readFileSync(path.join(dir, entry.page), "utf8");
            const headline = cheerio.load(html)(".countdown-value").first().text().trim();
            assert.match(headline, /No official date announced|Data unavailable/,
                `${entry.page} was supposed to have no value in this render, but reads "${headline}"`);
            for (const describes of DESCRIBES_A_VALUE) {
                assert.ok(!describes.test(html), `${entry.page} has no value to show but still points at one: ${describes}`);
            }
            exercised.push(entry.page);
        }
        // The population is the manifest, not "more than none". A guard whose coverage can quietly shrink
        // to one page is a guard that will pass on the day it matters.
        assert.deepEqual(exercised.sort(), trackerManifest().map(entry => entry.page).sort());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the privacy policy still describes the site that exists", () => {
    const privacy = read("privacy/index.html");
    assert.match(privacy, /includes the Google AdSense site code/);
    assert.match(privacy, /no ad placements of its own/);
    assert.match(privacy, /Google Analytics 4 \(GA4\)/);
    assert.match(privacy, /Google's own consent management platform/);
    // Nothing in V4 sends anything anywhere. The arcade keeps its records on the device, and the policy
    // does not need to claim otherwise — but it must not have become wrong either.
    assert.ok(!privacy.includes("No advertising code is served"));
});

/** Number words a page might reasonably use for a cadence, plus the digits the hub uses. */
const NUMBER_WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

const COUNT = `(\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;
// "every two weeks" and "a two-week patch cycle" are the same claim, and the pages use both (Codex, #73).
const WEEKS = new RegExp(`(?:every ${COUNT} weeks?|${COUNT}[- ]week\\b)`, "i");
const MONTHS = new RegExp(`(?:every ${COUNT} months?|${COUNT}[- ]month\\b)`, "i");

/** The cadence a sentence states, in weeks, or undefined where it states none. */
function weeksIn(text: string): number | undefined {
    const found = WEEKS.exec(text);
    if (!found) return undefined;
    const word = (found[1] ?? found[2]).toLowerCase();
    return NUMBER_WORDS[word] ?? Number(word);
}

/**
 * Every sentence on a page that states a cadence, in either form.
 *
 * Filtering on the words "how often" or "every" first (Codex, #73) threw away "roughly a two-week patch
 * cycle" before the parser could read it — which is how an overview could contradict the hub while the
 * FAQ answer beside it kept the comparison green.
 */
function cadenceClaims(page: cheerio.CheerioAPI): string[] {
    const said: string[] = [];
    page("details.faq-item, .content-section p, .page p").each((_, el) => {
        const text = page(el).text().replace(/\s+/g, " ");
        if (WEEKS.test(text) || MONTHS.test(text)) said.push(text);
    });
    return said;
}

/**
 * A knowledge store with known intervals, so the hub derives a cadence in every environment.
 *
 * `npm test` only ever runs in the PR check, which checks out the repository and nothing else — the
 * `knowledge/` worktree is created by the publish job. A guard that reads the real store therefore
 * compares nothing in the one place it would have caught something (Codex, #73).
 *
 * The spacing is chosen to match what each page claims, which is the point: the comparison asserts
 * the pages agree with a cadence derived exactly the way production derives it, so changing either
 * side breaks it.
 */
function cadenceFixture(root: string, spacingDays: Record<string, number>, now: Date): void {
    const games = path.join(root, "knowledge", "games");
    fs.mkdirSync(games, { recursive: true });
    for (const entry of trackerManifest()) {
        const days = spacingDays[entry.tracker!.game];
        if (days === undefined) continue;
        // cadenceOf needs four events and at least three gaps before it will call a rhythm regular.
        const events = Array.from({ length: 6 }, (_unused, i) => {
            const at = new Date(now.getTime() - (5 - i) * days * 86_400_000).toISOString();
            return {
                key: entry.tracker!.game + "/" + entry.tracker!.type + "/fixture-" + i,
                game: entry.tracker!.game,
                topic: entry.tracker!.type,
                kind: "version",
                label: "Fixture " + i,
                status: "observed",
                at,
                precision: "exact",
                timezone: "UTC",
                firstSeen: at,
                lastVerified: now.toISOString(),
                publishState: "published"
            };
        });
        fs.writeFileSync(path.join(games, entry.tracker!.game + ".json"), JSON.stringify({
            schemaVersion: 1,
            game: entry.tracker!.game,
            updatedAt: now.toISOString(),
            events,
            changes: [], overrides: [], documents: [], claims: [], sources: [], discovered: [], topicStates: []
        }, null, 2), "utf8");
    }
}
test("no tracker page states two different cadences for its own game", () => {
    // The check that needs neither a knowledge store nor a fixture, and the one that would have caught
    // what this PR found: the LoL overview said "a consistent two-week patch cycle throughout the year"
    // four paragraphs above a FAQ answer saying the cycle is not rigid.
    //
    // Comparing a page against the hub needs derived data, which only exists where the store does.
    // Comparing a page against itself needs nothing, so it runs everywhere and cannot be skipped.
    let checked = 0;
    for (const entry of trackerManifest()) {
        const page = cheerio.load(read(entry.page));
        const claims = cadenceClaims(page);
        const weeks = new Map<number, string>();
        for (const text of claims) {
            const stated = weeksIn(text);
            if (stated !== undefined && !weeks.has(stated)) weeks.set(stated, text);
        }
        if (weeks.size === 0) continue;
        checked++;
        assert.equal(weeks.size, 1,
            `${entry.page} states ${[...weeks.keys()].join(" and ")} weeks in different places:\n  ` +
            [...weeks.values()].map(text => `"${text.slice(0, 100)}"`).join("\n  "));

        // Months and weeks cannot both be the answer either.
        const months = claims.filter(text => MONTHS.test(text));
        assert.deepEqual(months, [],
            `${entry.page} states a cadence in months as well as weeks: "${months[0]?.slice(0, 100)}"`);
    }
    assert.ok(checked > 0, "no tracker page states a cadence at all — this guard is checking nothing");
});

test("no tracker's prose contradicts the cadence the site derives for it", () => {
    // /resets/ derives a cadence from the stored events; each tracker page also talks about how often
    // its game updates. They were allowed to disagree, and did: PUBG's page said "roughly every 2
    // months" while the hub published "About every 4 weeks" from that game's own patch history.
    //
    // Two pages of one site disagreeing about one fact is worse than either being vague, because a
    // reader who checks both learns they cannot trust either.
    // Its own render, against the seeded store, so the comparison happens everywhere rather than only
    // where someone has a knowledge worktree.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-cadence-root-"));
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-cadence-"));
    try {
        copyTree(path.join(ROOT, "public"), dist);
        seedFromLastKnownGood(path.join(dist, "data"));
        // The spacing each page states in its own words, so agreement is what passes.
        cadenceFixture(root, { lol: 14, pubg: 28 }, NOW);
        renderSite(dist, NOW, root);
        compareCadence((page: string) => fs.readFileSync(path.join(dist, page), "utf8"));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(dist, { recursive: true, force: true });
    }
});

/** The comparison itself, over whichever build it is handed. */
function compareCadence(read: (page: string) => string): void {
    const hub = cheerio.load(read("resets/index.html"));
    const stated = new Map<string, string>();
    hub("table tbody tr").each((_, row) => {
        const cells = hub(row).find("td,th").map((__, cell) => hub(cell).text().replace(/\s+/g, " ").trim()).get();
        if (cells.length >= 3 && WEEKS.exec(cells[2])) stated.set(cells[0], cells[2]);
    });

    // Seeded rather than borrowed. A derived cadence needs the knowledge store, and `npm test` only ever
    // runs in the PR check, which never creates the `knowledge/` worktree — so a guard that depends on the
    // real store exits without comparing anything in the one place it would have caught something
    // (Codex, #73). `cadenceFixture` builds a store with known intervals, so the hub has rows every time.
    assert.ok(stated.size > 0, "the hub derived no cadence from the seeded store");

    for (const entry of trackerManifest()) {
        const page = cheerio.load(read(entry.page));
        const title = page("h1").first().text().replace(/\s+/g, " ").trim();
        const hubRow = [...stated.entries()].find(([game]) => title.toLowerCase().startsWith(game.toLowerCase()));
        if (!hubRow) continue;
        const derived = weeksIn(hubRow[1])!;

        // Collected, then asserted. An assertion thrown inside a cheerio .each callback does not
        // reliably escape it, so an earlier version of this guard reported nothing while two pages were
        // contradicting the hub.
        const said = cadenceClaims(page);
        let compared = 0;
        for (const text of said) {
            assert.ok(!MONTHS.test(text),
                `${entry.page} describes a cadence in months while /resets/ publishes "${hubRow[1]}": "${text.slice(0, 110)}"`);
            const claimed = weeksIn(text);
            if (claimed === undefined) continue;
            compared++;
            assert.equal(claimed, derived,
                `${entry.page} says every ${claimed} weeks, /resets/ publishes "${hubRow[1]}"`);
        }
        // Both pages this guard was written for state their cadence in words, so a digits-only parser
        // read neither of them and the comparison never happened (Codex, #73). Requiring a comparison
        // per matched game is what stops that being invisible.
        //
        // A page may instead state no figure and send the reader to the hub for it. That cannot drift —
        // the hub's figure moves with the data (production read "About every 29 days" while PUBG's page
        // said four weeks) — and any figure such a page does state is still compared above.
        // Read from the page itself: such an answer states no figure, so cadenceClaims does not collect it.
        const defers = page("details.faq-item").toArray().some(el => {
            const text = page(el).text().replace(/\s+/g, " ");
            return /how often/i.test(page(el).find("summary").text()) && /reset times page/i.test(text) && weeksIn(text) === undefined && !MONTHS.test(text);
        });
        assert.ok(compared > 0 || defers, `${entry.page} states no cadence this guard can read, and does not defer to the reset times page, so nothing was compared against "${hubRow[1]}"`);
    }
}
