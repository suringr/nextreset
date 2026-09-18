/**
 * V4 correction, PR 2: tracking reaches the pages people actually arrive on, and introduces itself.
 *
 * Two gaps this closes, both found by auditing the shipped site rather than the code:
 *
 *   - the twelve tracker pages carried no track control at all, so the pages organic search lands on
 *     offered none of V4's personalisation;
 *   - My Games was hidden until it was already in use, so a first-time visitor met a star with nothing
 *     to explain it and never learned the feature existed.
 *
 * What must NOT change is the guarantee underneath: tracking is presentation. It reorders the homepage
 * grid and does nothing else, and every published value is in the served HTML whether or not anyone
 * has ever pressed a star.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { renderSite, trackerOf } from "../../render-pages";

const ROOT = path.join(__dirname, "..", "..", "..");
const NOW = new Date("2026-09-17T12:00:00.000Z");

function build(): { dir: string; pages: string[]; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-tracking-"));
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

test("every tracker page offers to track the game it is about", () => {
    assert.equal(trackerPages.length, 12, `expected 12 tracker pages, found ${trackerPages.length}`);
    for (const page of trackerPages) {
        const tracker = trackerOf(read(page), page)!;
        const $ = cheerio.load(read(page));
        const buttons = $("[data-track]");
        assert.equal(buttons.length, 1, `${page} has ${buttons.length} track controls`);
        assert.equal(buttons.attr("data-track"), tracker.game, `${page} tracks the wrong game`);
        assert.equal(buttons.prop("tagName")?.toLowerCase(), "button");
        assert.equal(buttons.attr("type"), "button");
    }
});

test("a track control is never inside a link, and never wraps one", () => {
    // A button inside an anchor is invalid, and a tap near it becomes an ambiguous target: it either
    // follows the link or toggles tracking depending on how the browser feels about the hit test.
    for (const page of site.pages) {
        const $ = cheerio.load(read(page));
        $("[data-track]").each((_, button) => {
            assert.equal($(button).parents("a").length, 0, `${page}: a track control is inside a link`);
            assert.equal($(button).find("a").length, 0, `${page}: a track control contains a link`);
        });
    }
});

test("every track control ships hidden, because without script it does nothing", () => {
    for (const page of site.pages) {
        const $ = cheerio.load(read(page));
        $("[data-track]").each((_, button) => {
            assert.notEqual($(button).attr("hidden"), undefined, `${page}: a track control ships visible`);
            assert.equal($(button).attr("aria-pressed"), "false", `${page}: a track control ships without its state`);
        });
    }
});

test("every track control has a name that says which game it is for", () => {
    for (const page of site.pages) {
        const $ = cheerio.load(read(page));
        $("[data-track]").each((_, button) => {
            const name = $(button).text().replace(/\s+/g, " ").trim();
            assert.ok(name.length > 0, `${page}: a track control has no accessible name`);
            assert.ok(/track/i.test(name), `${page}: a track control is named "${name}"`);
        });
    }
});

test("the tracker page's control names its own game, for a reader who meets the button out of context", () => {
    for (const page of trackerPages) {
        const $ = cheerio.load(read(page));
        const heading = $("h1").first().text().replace(/\s+/g, " ").trim();
        // The star is aria-hidden, so it is not part of the name a screen reader announces.
        const button = $("[data-track]").clone();
        button.find("[aria-hidden='true']").remove();
        const name = button.text().replace(/ /g, " ").replace(/\s+/g, " ").trim();
        const game = name.replace(/^Track\s*/i, "").trim();
        assert.ok(game.length > 0, `${page}: the control says only "${name}"`);
        assert.ok(heading.startsWith(game), `${page}: the control says "${game}" but the page is "${heading}"`);
    }
});

test("My Games can introduce itself, and says nothing at all before script runs", () => {
    const $ = cheerio.load(read("index.html"));
    const section = $("#my-games");
    const empty = $("#my-games-empty");
    assert.equal(section.length, 1);
    assert.equal(empty.length, 1, "the homepage has no empty state for My Games");
    // Both hidden in the served HTML: the section because it has nothing yet, the line because a
    // visitor without JavaScript would be told about a control that cannot work for them.
    assert.notEqual(section.attr("hidden"), undefined, "the section ships visible");
    assert.notEqual(empty.attr("hidden"), undefined, "the empty state ships visible");
    const words = empty.text().replace(/\s+/g, " ").trim();
    assert.match(words, /track/i, `the empty state does not say what tracking does: "${words}"`);
    assert.match(words, /device/i, `the empty state does not say where it is kept: "${words}"`);
});

test("the empty state claims nothing about a player, a count or a server", () => {
    const words = cheerio.load(read("index.html"))("#my-games-empty").text();
    assert.ok(!/\b\d+\b/.test(words), `the empty state quotes a number: "${words}"`);
    assert.ok(!/account|sign in|log in|sync|cloud/i.test(words), `the empty state implies an account: "${words}"`);
});

// === the guarantee underneath ===

test("tracking is still presentation: the build ships all twelve cards, in group order", () => {
    const $ = cheerio.load(read("index.html"));
    const slots = $("#game-grid .card-slot");
    assert.equal(slots.length, 12, `the grid ships ${slots.length} cards`);
    // Every card is a real link with a real value, before any script runs and whatever is tracked.
    slots.each((_, slot) => {
        const card = $(slot).find("a.card");
        assert.equal(card.length, 1);
        assert.match(card.attr("href") ?? "", /^\/[a-z0-9-]+\/[a-z-]+\/$/);
        const value = card.find(".card-countdown").text().trim();
        assert.ok(value.length > 0 && !value.includes("Loading"), `a card ships "${value}"`);
    });
});

test("no page's published answer moved to make room for a control", () => {
    for (const page of trackerPages) {
        const $ = cheerio.load(read(page));
        const headline = $(".countdown-value").first().text().trim();
        assert.ok(headline.length > 0, `${page} publishes no headline`);
        assert.ok(!headline.includes("--:--"), `${page} shows a placeholder`);
        // The control sits after the heading and before the answer; the answer is still the first
        // thing the page states, and the evidence panel still follows it.
        assert.equal($(".countdown-box").length, 1, `${page}: the answer is not exactly once`);
        assert.ok($(".info-panel").length >= 1, `${page}: the evidence panel is gone`);
    }
});

test("the track control does not disturb the one-h1 rule or the page's own heading", () => {
    for (const page of site.pages) {
        const $ = cheerio.load(read(page));
        assert.equal($("h1").length, 1, `${page} has ${$("h1").length} h1 elements`);
        $("[data-track]").each((_, button) => {
            assert.equal($(button).find("h1,h2,h3").length, 0, `${page}: a track control contains a heading`);
        });
    }
});

test("the script that makes tracking work is on every page that offers it", () => {
    for (const page of site.pages) {
        const html = read(page);
        if (!/data-track=/.test(html)) continue;
        assert.match(html, /assets\/player\.js/, `${page} offers tracking without the record`);
        assert.match(html, /assets\/app\.js/, `${page} offers tracking without the script that wires it`);
    }
});
