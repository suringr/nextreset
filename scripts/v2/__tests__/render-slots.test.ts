/**
 * V4, PR 1: the renderers address slots, not spellings.
 *
 * Every assertion here is about the same trade. The renderers must stop breaking when a page is
 * edited in ways that change nothing — a reworded placeholder, two attributes swapped, a line
 * reformatted — without loosening what happens when a page genuinely can no longer be rendered. So:
 * finding a slot is tolerant, and failing to find exactly one still throws.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findByAttribute, findByTag, hasClass, maskNonMarkup, parseAttributes, spliceElement } from "../../html-elements";
import { SlotError, cardRegion, locateSlot, replaceSlot } from "../../render-slots";

test("attributes are read however they were written", () => {
    const attributes = parseAttributes(`<div id="notes" class='a b' data-x=7 hidden data-nr-slot="notes">`);
    assert.equal(attributes.id, "notes");
    assert.equal(attributes.class, "a b");
    assert.equal(attributes["data-x"], "7");
    assert.equal(attributes.hidden, "");
    assert.equal(attributes["data-nr-slot"], "notes");
    // The tag name is not an attribute, which is the bug a naive split produces.
    assert.equal(attributes.div, undefined);
});

test("a class is a token, not a substring", () => {
    assert.equal(hasClass({ class: "card featured" }, "card"), true);
    assert.equal(hasClass({ class: "card-countdown" }, "card"), false);
    assert.equal(hasClass({}, "card"), false);
});

test("an element's range covers itself and its nesting, not the next close tag it meets", () => {
    const html = `<div id="outer"><div id="inner">x</div>tail</div><div id="after"></div>`;
    const outer = findByTag(html, "div").find(e => e.attributes.id === "outer")!;
    assert.equal(outer.source, `<div id="outer"><div id="inner">x</div>tail</div>`);
    assert.equal(outer.inner, `<div id="inner">x</div>tail`);
    // Nested elements are reported too, so a slot inside a slot can still be addressed.
    assert.deepEqual(findByTag(html, "div").map(e => e.attributes.id), ["outer", "inner", "after"]);
});

test("markup inside a script, a style or a comment is not an element", () => {
    const html = [
        `<style>.card{}</style>`,
        `<script>var s = "<div id=\\"fake\\"></div>";</script>`,
        `<!-- <div id="commented"></div> -->`,
        `<div id="real">ok</div>`
    ].join("\n");
    assert.deepEqual(findByTag(html, "div").map(e => e.attributes.id), ["real"]);
    // Masking keeps every offset and every line break, because ranges index the original string.
    const masked = maskNonMarkup(html);
    assert.equal(masked.length, html.length);
    assert.equal(masked.split("\n").length, html.split("\n").length);
});

test("looking for a style or a script reveals that kind, since masking it would hide the search itself", () => {
    const html = `<head>\n  <style>.a{color:red}</style>\n  <script>var x = 1;</script>\n</head>`;
    const styles = findByTag(html, "style");
    assert.equal(styles.length, 1);
    assert.equal(styles[0].inner, ".a{color:red}");
    assert.equal(findByTag(html, "script").length, 1);
    // The other kind stays masked, so CSS that mentions a tag name is still not markup.
    assert.equal(findByTag(`<style>div{color:red}</style><div id="real"></div>`, "div").length, 1);
});

test("an element reports the indentation of its own line, and nothing else's", () => {
    const html = `<body>\n    <div id="a"></div>\n<p>x</p><div id="b"></div>\n</body>`;
    const found = findByTag(html, "div");
    assert.equal(found.find(e => e.attributes.id === "a")!.indent, "    ");
    assert.equal(found.find(e => e.attributes.id === "b")!.indent, "", "it does not start its line, so there is no indent to reuse");
});

test("an unclosed element costs itself, not the rest of the document", () => {
    const html = `<div id="broken"><span id="fine">x</span>`;
    assert.deepEqual(findByTag(html, "div").map(e => e.attributes.id), [], "the unclosed div is skipped");
    assert.deepEqual(findByTag(html, "span").map(e => e.attributes.id), ["fine"]);
});

test("a void element inside a slot does not swallow the closing tag", () => {
    const html = `<div id="a"><img src="x.png"><br>text</div>`;
    const div = findByTag(html, "div")[0];
    assert.equal(div.source, html);
});

const PAGE = [
    `<section>`,
    `  <div class="countdown-box" id="countdown">`,
    `    <div class="countdown-label">Checking official sources...</div>`,
    `    <div class="countdown-value countdown-skeleton">--:--:--</div>`,
    `  </div>`,
    `  <div class="info-panel">`,
    `    <div class="info-row"><span class="info-label">Source</span><span class="info-value" id="source">...</span></div>`,
    `    <div class="info-row"><span class="info-label">Confidence</span><span id="confidence" class="confidence">...</span></div>`,
    `    <div class="info-row">`,
    `      <span class="info-label">Last Updated</span>`,
    `      <span class="info-value" id="last-updated">...</span>`,
    `    </div>`,
    `  </div>`,
    `  <div id="notes" class="notes" style="display: none;"></div>`,
    `  <div id="verified-data"></div>`,
    `</section>`
].join("\n");

test("every tracker slot is found in a page that never heard of slots", () => {
    for (const slot of ["answer-label", "answer-value", "source", "confidence", "meta-rows", "notes", "verified-data"] as const) {
        assert.doesNotThrow(() => locateSlot(PAGE, slot, "fixture"), `${slot} was not found`);
    }
    // The verification rows are the one slot three identical-looking rows compete for.
    assert.ok(locateSlot(PAGE, "meta-rows", "fixture").inner.includes("last-updated"));
    assert.equal(locateSlot(PAGE, "meta-rows", "fixture").indent, "    ");
});

test("a declared slot wins over the structural fallback", () => {
    const declared = PAGE.replace(`<div id="notes" class="notes" style="display: none;"></div>`, `<aside data-nr-slot="notes"></aside>`);
    assert.equal(locateSlot(declared, "notes", "fixture").name, "aside");
});

test("a missing slot and a duplicated slot both stop the build", () => {
    const gone = PAGE.replace(`<div id="verified-data"></div>`, "");
    assert.throws(() => locateSlot(gone, "verified-data", "fixture"), SlotError);
    assert.throws(() => locateSlot(gone, "verified-data", "fixture"), /expected exactly one "verified-data" slot/);

    const twice = PAGE.replace(`<div id="verified-data"></div>`, `<div id="verified-data"></div><div id="verified-data"></div>`);
    assert.throws(() => locateSlot(twice, "verified-data", "fixture"), /found 2/);
});

test("replacing a slot changes that element and nothing else", () => {
    const out = replaceSlot(PAGE, "notes", () => `<div id="notes" class="notes">hello</div>`, "fixture");
    assert.ok(out.includes(`<div id="notes" class="notes">hello</div>`));
    assert.ok(out.includes(`<div id="verified-data"></div>`), "its neighbours are untouched");
    assert.equal(out.split("\n").length, PAGE.split("\n").length, "and the page keeps its shape");
});

test("a slot with nothing to say can return the element it was given", () => {
    assert.equal(replaceSlot(PAGE, "notes", element => element.source, "fixture"), PAGE);
});

test("splicing is exact", () => {
    const html = `<p>a</p><p>b</p>`;
    const second = findByTag(html, "p")[1];
    assert.equal(spliceElement(html, second, `<p>B</p>`), `<p>a</p><p>B</p>`);
});

const CARDS = [
    `<div class="grid" id="game-grid">`,
    `      <a class="card" data-game="lol">one</a>`,
    ``,
    `      <a class="card" data-game="gta">two</a>`,
    `</div>`
].join("\n");

function blocksOf(html: string): Array<{ block: string; index: number }> {
    return findByAttribute(html, "class", "card").map(e => ({ block: e.source, index: e.start }));
}

test("without a declared region the renderer owns only the span from the first card to the last", () => {
    const cards = blocksOf(CARDS);
    const region = cardRegion(CARDS, cards, "home");
    assert.equal(region.owned, false);
    assert.equal(CARDS.slice(region.start, region.end).startsWith(`<a class="card"`), true);
    assert.equal(CARDS.slice(region.start, region.end).endsWith(`</a>`), true);
});

test("content between cards still stops the build, because the rewrite would destroy it", () => {
    const withBanner = CARDS.replace(`\n\n      <a class="card" data-game="gta">`, `\n<p>keep me</p>\n      <a class="card" data-game="gta">`);
    assert.throws(() => cardRegion(withBanner, blocksOf(withBanner), "home"), /unexpected content between cards/);
});

test("a declared region hands the renderer everything inside it", () => {
    const owned = `<div data-nr-region="cards">\n  <a class="card" data-game="lol">one</a>\n</div>`;
    const region = cardRegion(owned, blocksOf(owned), "home");
    assert.equal(region.owned, true);
    assert.equal(owned.slice(region.start, region.end), `\n  <a class="card" data-game="lol">one</a>\n`);
    // Which is the point: headings and wrappers between cards are now the renderer's to emit.
    assert.doesNotThrow(() => cardRegion(
        `<div data-nr-region="cards"><h2>Next up</h2><a class="card" data-game="lol">one</a><h2>Later</h2><a class="card" data-game="gta">two</a></div>`,
        blocksOf(`<div data-nr-region="cards"><h2>Next up</h2><a class="card" data-game="lol">one</a><h2>Later</h2><a class="card" data-game="gta">two</a></div>`),
        "home"
    ));
});

test("two cards regions are as unrenderable as none", () => {
    const twice = `<div data-nr-region="cards"></div><div data-nr-region="cards"></div>`;
    assert.throws(() => cardRegion(twice, [], "home"), /expected at most one "cards" region/);
    assert.throws(() => cardRegion(`<div></div>`, [], "home"), /no cards found/);
});
