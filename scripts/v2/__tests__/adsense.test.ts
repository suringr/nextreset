/**
 * The AdSense site integration.
 *
 * This site was rejected once for low value content, and the response to that is the rest of Publishing
 * V2 — not ad code. What these tests hold is narrower: that the site code Google asks for is present,
 * exactly once, on exactly the pages we decided should carry it, with the publisher's real client; that
 * the ad units this repository once had never come back; and that the privacy policy still describes
 * what the site actually does now that the code is there.
 *
 * The last one is the point of testing a policy document at all. A privacy policy that contradicts the
 * page it sits on is worse than no policy, and the sentence that used to be true here — "no advertising
 * code is served on the Site today" — became false the moment the loader shipped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { ADSENSE_CLIENT, ADSENSE_LOADER, adsenseLoaderCount, carriesLoader, hasAdUnitMarkup } from "../../adsense";

const ROOT = path.join(__dirname, "..", "..", "..");
const PUBLIC = path.join(ROOT, "public");

/** Every authored HTML page, 404 included — the one page whose absence from the list is the point. */
function authoredHtml(): string[] {
    const pages: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) pages.push(path.relative(PUBLIC, full).replace(/\\/g, "/"));
        }
    };
    walk(PUBLIC);
    return pages.sort();
}

const PAGES = authoredHtml();
const read = (page: string) => fs.readFileSync(path.join(PUBLIC, page), "utf8");

test("the site has the pages this test thinks it has", () => {
    // If a page is added and this list is not, the coverage tests below would pass by never looking.
    assert.equal(PAGES.length, 17, `expected 17 authored pages, found ${PAGES.length}: ${PAGES.join(", ")}`);
    assert.ok(PAGES.includes("404.html"));
    assert.ok(PAGES.includes("index.html"));
    assert.ok(PAGES.includes("play/index.html"), "the arcade route");
    assert.equal(PAGES.filter(p => p.split("/").length === 3).length, 12, "expected 12 tracker pages");
});

test("the arcade carries no ad code at all", () => {
    // Not a placement, not even the library. `/play/` is an interactive surface where a mis-tap costs a
    // life, and Auto ads position anchors and vignettes from the account, which this repository cannot
    // see. The only way to be sure nothing lands over the board is for the page not to load it.
    assert.equal(carriesLoader("play/index.html"), false);
    assert.equal(adsenseLoaderCount(read("play/index.html")), 0);
    assert.equal(hasAdUnitMarkup(read("play/index.html")), false);
    // And it says why, so the next person to add a page does not restore it by pattern-matching.
    const rule = fs.readFileSync(path.join(ROOT, "scripts", "adsense.ts"), "utf8");
    assert.match(rule, /play\/index\.html/);
    assert.match(rule, /interactive surface/);
});

test("every other content page still carries the loader", () => {
    // The exclusions are two, named, and deliberate. Nothing else may quietly join them.
    const without = PAGES.filter(page => !carriesLoader(page));
    assert.deepEqual(without.sort(), ["404.html", "play/index.html"]);
});

test("every content page carries the loader, exactly once", () => {
    for (const page of PAGES.filter(carriesLoader)) {
        assert.equal(adsenseLoaderCount(read(page)), 1, `${page} should carry exactly one AdSense loader`);
    }
});

test("the loader on each page is Google's snippet, with our client", () => {
    for (const page of PAGES.filter(carriesLoader)) {
        assert.ok(read(page).includes(ADSENSE_LOADER), `${page} does not carry the canonical loader`);
    }
    assert.equal(ADSENSE_CLIENT, "ca-pub-8986430839492258");
    assert.match(
        ADSENSE_LOADER,
        /^<script async src="https:\/\/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js\?client=ca-pub-8986430839492258" crossorigin="anonymous"><\/script>$/
    );
});

test("the loader sits in the head, where Google documents it", () => {
    for (const page of PAGES.filter(carriesLoader)) {
        const $ = cheerio.load(read(page));
        assert.equal($(`head script[src*="adsbygoogle.js"]`).length, 1, `${page}: loader is not in <head>`);
    }
});

test("the 404 page carries no ad code", () => {
    // Google's publisher policy does not allow ads on screens used for alerts or navigation. A
    // not-found page is both, so it is left out on purpose rather than by oversight.
    assert.equal(carriesLoader("404.html"), false);
    assert.equal(adsenseLoaderCount(read("404.html")), 0);
});

test("no page carries an ad unit", () => {
    for (const page of PAGES) {
        assert.equal(hasAdUnitMarkup(read(page)), false, `${page} contains ad-unit markup`);
    }
});

test("the ad slots this repository used to have do not come back", () => {
    for (const page of PAGES) {
        const html = read(page);
        for (const slot of ["3246306240", "6919083675"]) {
            assert.ok(!html.includes(slot), `${page} contains retired ad slot ${slot}`);
        }
        assert.ok(!html.includes("data-ad-slot"), `${page} declares an ad slot`);
        assert.ok(!html.includes("data-ad-client"), `${page} declares an inline ad client`);
    }
});

test("the tracker pages get the loader from the template, not twelve edits", () => {
    const template = fs.readFileSync(path.join(ROOT, "scripts", "update-game-pages.ts"), "utf8");
    assert.ok(template.includes("${ADSENSE_LOADER}"), "the generator should interpolate the shared constant");
    assert.ok(!template.includes("pagead2.googlesyndication.com"), "the generator should not hardcode the snippet");
});

test("a duplicated loader is detected however it is written", () => {
    assert.equal(adsenseLoaderCount(""), 0);
    assert.equal(adsenseLoaderCount(ADSENSE_LOADER), 1);
    assert.equal(adsenseLoaderCount(ADSENSE_LOADER + ADSENSE_LOADER), 2);
    // Attribute order and client differ; it is still a second copy of the library.
    const reordered = `<script crossorigin="anonymous" src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-999"></script>`;
    assert.equal(adsenseLoaderCount(ADSENSE_LOADER + reordered), 2);
});

test("ad-unit markup is recognised in both forms", () => {
    assert.equal(hasAdUnitMarkup(ADSENSE_LOADER), false);
    assert.equal(hasAdUnitMarkup(`<ins class="adsbygoogle" data-ad-slot="123"></ins>`), true);
    assert.equal(hasAdUnitMarkup(`<ins class="adsbygoogle adsbygoogle-noablate"></ins>`), true);
    assert.equal(hasAdUnitMarkup(`<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>`), true);
});

test("ads.txt publishes the publisher record and nothing else", () => {
    const adsTxt = fs.readFileSync(path.join(PUBLIC, "ads.txt"), "utf8");
    assert.ok(!adsTxt.startsWith("﻿"), "ads.txt must not begin with a byte-order mark");
    assert.ok(!/<html/i.test(adsTxt), "ads.txt must be the record, not an HTML fallback page");

    const records = adsTxt.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    assert.deepEqual(records, ["google.com, pub-8986430839492258, DIRECT, f08c47fec0942fa0"]);

    // The ads.txt publisher ID and the ad client are the same account, written two ways. A mismatch
    // here is the version of this bug that looks fine on both pages and earns an unauthorised-seller
    // warning in the account.
    const publisherId = records[0].split(",")[1].trim();
    assert.equal(`ca-${publisherId}`, ADSENSE_CLIENT);
});

test("the privacy policy describes the site that now exists", () => {
    const privacy = read("privacy/index.html");

    // The claims that shipping the loader falsified.
    assert.ok(!privacy.includes("No advertising code is served"), "the policy still claims no ad code is served");
    assert.ok(!privacy.includes("if and when advertising is enabled"), "the policy still defers advertising to a future date");
    assert.ok(!privacy.includes("once enabled"), "the policy still lists AdSense as not yet in use");

    // What is true instead.
    assert.match(privacy, /includes the Google AdSense site code/);
    assert.match(privacy, /no ad placements of its own/);

    // Unchanged, and still required: Analytics is disclosed and still running.
    assert.match(privacy, /Google Analytics 4 \(GA4\)/);
    assert.match(privacy, /Google Analytics Opt-out Browser Add-on/);
});

test("the privacy policy describes the consent platform that is actually configured", () => {
    const privacy = read("privacy/index.html");

    // The claim the account's published European regulations message falsified.
    assert.ok(!privacy.includes("No consent management platform is configured"), "the policy still denies the CMP");

    // What is configured: Google's own CMP, account-side, for this site.
    assert.match(privacy, /Google's own consent management platform/);
    assert.match(privacy, /AdSense Privacy &amp; messaging/);
    assert.match(privacy, /European regulations message/);

    // And what it must not overstate. Not every visitor sees the message, and consent being available
    // is not the same as personalised advertising being switched on.
    assert.match(privacy, /Where it applies/);
    assert.ok(!/personalised advertising is (now )?(active|enabled|on)\b/i.test(privacy),
        "the policy claims personalised advertising is active");
});

test("the consent platform is Google's, not code in this repository", () => {
    // Google serves the message through the AdSense code already on the page. No official
    // documentation asks an AdSense publisher to add a CMP, Funding Choices or TCF tag for this
    // configuration, so nothing here may quietly grow one.
    for (const page of PAGES) {
        assert.ok(!/__tcfapi|googlefc|fundingchoices/i.test(read(page)), `${page} implements its own consent platform`);
    }
});

test("analytics survived the change", () => {
    // The loader was inserted next to the Analytics tag; this is the guard against landing on top of it.
    const withAnalytics = PAGES.filter(page => read(page).includes("G-YY6V5SR1DN"));
    assert.equal(withAnalytics.length, 16, "Analytics should remain on all 16 content pages");
    assert.ok(!withAnalytics.includes("404.html"));
    // The arcade has no ad code and still has analytics: they are separate decisions.
    assert.ok(withAnalytics.includes("play/index.html"));
});
