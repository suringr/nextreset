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

/** Builds the site into a temporary directory, exactly as export:site + render:pages do. */
function build(): { dir: string; pages: string[]; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-whole-"));
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
    assert.equal(trackerPages.length, 12, `expected 12 tracker pages, found ${trackerPages.length}`);
    assert.ok(site.pages.includes("index.html"));
    assert.ok(site.pages.includes("play/index.html"));
    assert.ok(site.pages.includes("404.html"));
    assert.ok(site.pages.includes("about/index.html") && site.pages.includes("privacy/index.html"));
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
