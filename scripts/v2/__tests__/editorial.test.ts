/**
 * The About page is where a reader — or a reviewer — finds out who stands behind the site and how it
 * works. It is held to what it must say, and to what it must not invent.
 *
 * And the tracker pages no longer carry the generic material the audit counted as most of their words:
 * "What Changes" lists of general game knowledge that no data stood behind.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { trackerPages } from "../../site-map";
import { gamePages } from "../../update-game-pages";

const PUBLIC = path.join(__dirname, "..", "..", "..", "public");
const read = (page: string) => fs.readFileSync(path.join(PUBLIC, page), "utf8");

test("About explains what the site provides, its sources, its checks, its uncertainty and its corrections", () => {
    const $ = cheerio.load(read("about/index.html"));
    const headings = $("h2").map((_, h) => $(h).text().trim()).get();
    for (const required of ["What you will find here", "How sources are chosen", "How values are checked", "When we do not know", "Corrections", "Who runs NextReset", "Contact"]) {
        assert.ok(headings.includes(required), `About has no "${required}" section`);
    }
    const text = $("body").text().replace(/\s+/g, " ");
    assert.match(text, /language model/, "the one use of a language model is disclosed");
    assert.match(text, /word for word/, "and what holds it to the source");
    assert.match(text, /not affiliated/i);
});

test("About invents no contact details and links each correction to the change that made it", () => {
    const html = read("about/index.html");
    const $ = cheerio.load(html);
    // An address appears here only once the owner supplies one; until then the contact is the public tracker.
    assert.doesNotMatch($("body").text(), /[\w.+-]+@[\w-]+\.[\w.]+/, "no email address the owner has not supplied");
    assert.equal($('a[href^="mailto:"]').length, 0);
    assert.ok($('a[href="https://github.com/suringr/nextreset/issues"]').length > 0, "the contact route is a real, public one");

    const corrections = $("h2").filter((_, h) => $(h).text().trim() === "Corrections").nextUntil("h2").find("li");
    assert.ok(corrections.length >= 3);
    corrections.each((_, li) => {
        assert.match($(li).find("a").attr("href") ?? "", /^https:\/\/github\.com\/suringr\/nextreset\/pull\/\d+$/, `correction without its change: ${$(li).text().slice(0, 60)}`);
    });
});

test("tracker pages carry no generic What Changes list", () => {
    for (const page of gamePages) assert.deepEqual(page.whatChanges, [], `${page.path} still has a What Changes list`);
    for (const entry of trackerPages()) {
        assert.doesNotMatch(read(entry.page), /<!-- What Changes -->|<h2>What Changes<\/h2>/, `${entry.page} still renders a What Changes section`);
    }
});

test("no two tracker pages share an FAQ answer", () => {
    // "When was the last X update? Whenever X last shipped one…" was the same answer on six pages.
    const seen = new Map<string, string>();
    for (const page of gamePages) {
        for (const { q, a } of page.faq) {
            const shape = a.replace(/\b(Valve|KRAFTON|Riot|EA|Activision|Mojang|HoYoverse|Rockstar|Epic)\b/g, "X").toLowerCase();
            const other = seen.get(shape);
            assert.equal(other, undefined, `${page.path} repeats ${other}'s answer to "${q}"`);
            seen.set(shape, page.path);
        }
        assert.ok(!page.faq.some(f => /^When (was|did) the last/.test(f.q)), `${page.path}: the page answers "when was the last" above; the FAQ need not`);
    }
});
