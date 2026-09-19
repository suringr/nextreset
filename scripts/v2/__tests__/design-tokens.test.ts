/**
 * V4, PR 2: the design system is one source, and it is legible.
 *
 * Three failures these tests exist to prevent, all of which the site had shipped:
 *
 *   1. Text that cannot be read. `--text-muted: #6b7280` on `#0b0f14` is 3.98:1, and it set the info
 *      labels, the card meta, the countdown label and the hero subtitle — all of them 11 to 13 pixels,
 *      all of them below the 4.5:1 AA threshold. Nothing in the build would ever have mentioned it.
 *   2. A palette maintained in sixteen places. The colours lived in `styles.v2.css` and again in an
 *      inline critical-CSS block hand-written per page, and they had drifted, so every page painted one
 *      palette and settled into another.
 *   3. A desktop-first cascade. The base rule was a three-column grid and phones undid it twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { AA_LARGE, AA_NORMAL, contrast, hueDistance, parseHex, ratio } from "../../design/contrast";
import { CRITICAL_PAGE_RULES, TEXT_ON_SURFACE, TOKEN, TOKENS, criticalCss, pageKind, rootBlock } from "../../design/tokens";
import { minifyCss, tokenize } from "../../minify-css";
import { TOKENS_END, TOKENS_START, applyCriticalCss, applyManifest, applyTokensToStylesheet, authoredPages, criticalStyleOf } from "../../update-design";

const ROOT = path.join(__dirname, "..", "..", "..");
const PUBLIC = path.join(ROOT, "public");
const STYLESHEET = fs.readFileSync(path.join(PUBLIC, "assets", "styles.v2.css"), "utf8");
const PAGES = authoredPages();
const read = (page: string) => fs.readFileSync(path.join(PUBLIC, page), "utf8");

test("the contrast maths matches the WCAG worked examples", () => {
    assert.equal(ratio("#ffffff", "#000000"), 21);
    assert.equal(ratio("#ffffff", "#ffffff"), 1);
    assert.deepEqual(parseHex("#fff"), [255, 255, 255]);
    assert.deepEqual(parseHex("0b1325"), [11, 19, 37]);
    assert.throws(() => parseHex("#nope"), /not a hex colour/);
    // The value this whole section is a response to.
    assert.equal(ratio("#6b7280", "#0b0f14"), 3.98);
});

test("every text token clears AA on every surface it is used on", () => {
    for (const { ink, on, minimum, note } of TEXT_ON_SURFACE) {
        for (const surface of on) {
            const measured = contrast(TOKEN[ink], TOKEN[surface]);
            assert.ok(
                measured >= minimum,
                `${ink} on ${surface} is ${ratio(TOKEN[ink], TOKEN[surface])}:1, needs ${minimum}:1 (${note})`
            );
        }
    }
    // And the thresholds are the real ones, so a later edit cannot quietly lower the bar.
    assert.equal(AA_NORMAL, 4.5);
    assert.equal(AA_LARGE, 3);
});

test("the state colours are three distinguishable things, and none of them is the brand", () => {
    // The brand and "verified" used to be the same green, so the site could not show the difference
    // between its own identity and a verified value. Distinguishability is a question about hue, not
    // about contrast: a vivid green and a vivid amber have nearly the same luminance.
    const states = {
        verified: TOKEN["--state-verified"],
        stale: TOKEN["--state-stale"],
        unavailable: TOKEN["--state-unavailable"]
    };
    const brand = TOKEN["--brand"];
    const pairs: Array<[string, string]> = [["verified", "stale"], ["verified", "unavailable"], ["stale", "unavailable"]];
    for (const [a, b] of pairs) {
        const apart = hueDistance(states[a as keyof typeof states], states[b as keyof typeof states]);
        assert.ok(apart >= 40, `${a} and ${b} are only ${apart}° apart in hue`);
    }
    for (const [name, value] of Object.entries(states)) {
        assert.notEqual(value, brand, `${name} must not also be the brand colour`);
        assert.ok(hueDistance(value, brand) >= 40, `${name} is only ${hueDistance(value, brand)}° from the brand hue`);
    }
});

test("no state is signalled by colour alone", () => {
    // Every badge carries its own word, so a reader who cannot separate the hues still reads the state.
    // The renderer decides both together; this holds them together.
    const home = fs.readFileSync(path.join(ROOT, "scripts", "render-home.ts"), "utf8");
    for (const [badge, text] of [["badge-live", "LIVE"], ["badge-stale", "STALE"], ["badge-unavailable", "UNAVAILABLE"], ["badge-unavailable", "NO DATE"]]) {
        assert.ok(home.includes(badge) && home.includes(text), `${badge} has no accompanying text (${text})`);
    }
});

test("the stylesheet's token block is the generated one", () => {
    const start = STYLESHEET.indexOf(TOKENS_START);
    const end = STYLESHEET.indexOf(TOKENS_END);
    assert.ok(start >= 0 && end > start, "the generated markers are present and in order");
    const block = STYLESHEET.slice(start + TOKENS_START.length, end).replace(/\r\n/g, "\n").trim();
    assert.equal(block, rootBlock().trim(), "run `npm run design:apply`");
});

test("applying tokens twice changes nothing the second time", () => {
    const once = applyTokensToStylesheet(STYLESHEET);
    assert.equal(applyTokensToStylesheet(once), once);
    assert.throws(() => applyTokensToStylesheet(":root{}"), /markers are missing/);
});

test("every page's first-paint CSS is the generated block for its kind", () => {
    for (const page of PAGES) {
        const html = read(page);
        const inline = criticalStyleOf(html, page).inner.replace(/\r\n/g, "\n").trim();
        assert.equal(inline, criticalCss(pageKind(page)), `${page}: run \`npm run design:apply\``);
        // Idempotent, so the generator is safe to run in a loop or a hook.
        assert.equal(applyCriticalCss(html, pageKind(page), page), html, `${page} is not stable under the generator`);
    }
});

test("a page's kind comes from where it sits in the build", () => {
    assert.equal(pageKind("index.html"), "home");
    assert.equal(pageKind("lol/next-patch/index.html"), "tracker");
    assert.equal(pageKind("about/index.html"), "static");
    assert.equal(pageKind("404.html"), "static");
});

test("the browser chrome and the installed app use the page's own ground colour", () => {
    const ground = TOKEN["--ground"];
    for (const page of PAGES) {
        assert.ok(
            read(page).includes(`<meta name="theme-color" content="${ground}">`),
            `${page} declares a theme colour that is not the page ground`
        );
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, "site.webmanifest"), "utf8"));
    assert.equal(manifest.theme_color, ground);
    assert.equal(manifest.background_color, ground);
    // And the generator is idempotent here too.
    const raw = fs.readFileSync(path.join(PUBLIC, "site.webmanifest"), "utf8");
    assert.equal(applyManifest(raw).replace(/\r\n/g, "\n"), raw.replace(/\r\n/g, "\n"));
});

/** The stylesheet with the generated token block removed: everything a person authored. */
function authoredCss(): string {
    const start = STYLESHEET.indexOf(TOKENS_START);
    const end = STYLESHEET.indexOf(TOKENS_END) + TOKENS_END.length;
    return STYLESHEET.slice(0, start) + STYLESHEET.slice(end);
}

test("no colour is written outside the token block", () => {
    // A colour written inline is a colour no contrast test can find, which is how the site ended up
    // shipping text at 3.98:1. Translucent fills are tokens too (--verified-soft, --sheen) for the
    // same reason.
    const css = authoredCss().replace(/\/\*[\s\S]*?\*\//g, "");
    const literals = [
        ...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
        ...css.matchAll(/\brgba?\s*\(/g),
        ...css.matchAll(/\bhsla?\s*\(/g)
    ].map(m => m[0]);
    assert.deepEqual(literals, [], `colour literals outside :root — make them tokens: ${literals.join(", ")}`);
});

test("no page writes a colour into a style attribute either", () => {
    // Codex P2 on #47. The stylesheet was clean and the homepage still painted its prose with forty
    // inline declarations of the pre-V4 palette, which override the stylesheet and which no contrast
    // test reads. A colour in a style attribute is a colour outside the token block, like any other.
    for (const page of PAGES) {
        const html = fs.readFileSync(path.join(PUBLIC, page), "utf8");
        const body = html.slice(html.indexOf("<body"));
        const found = [...body.matchAll(/style="([^"]*)"/g)]
            .map(m => m[1])
            .filter(style => /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/.test(style));
        assert.deepEqual(found, [], `${page} writes colours inline: ${found.join(" | ")}`);
    }
});

test("the wordmark's accent is the brand, and green stays the colour of a verified value", () => {
    // Codex P2 on #47: every page spent the verified green on decoration. The demo's wordmark draws its
    // "//" in the brand violet, and nothing in the header may borrow the verified green.
    assert.match(criticalCss("home"), /\.chrome-brand i\{[^}]*color:var\(--brand\)/);
    const header = criticalCss("home").match(/\.chrome[^{]*\{[^}]*\}/g) ?? [];
    assert.ok(header.length > 5, "the header's rules are in the critical CSS");
    for (const rule of header) assert.ok(!rule.includes("--state-verified"), `the header spends the verified green: ${rule}`);
});

test("every custom property the stylesheet reads is one the token block declares", () => {
    const declared = new Set(TOKENS.map(([name]) => name));
    const used = new Set([...authoredCss().matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
    for (const name of used) {
        assert.ok(declared.has(name), `${name} is used but never declared`);
    }
    assert.ok(used.size > 20, `expected the stylesheet to be built on tokens, found ${used.size}`);
});

test("the cascade is mobile-first: nothing is undone at a smaller width", () => {
    // Every query adds. A `max-width` query means the base rule was written for a desktop and is being
    // taken away again, which is what the previous stylesheet did twice.
    const queries = [...authoredCss().matchAll(/@media[^{]+/g)].map(m => m[0]);
    assert.ok(queries.length > 0, "there are width queries to check");
    for (const query of queries) {
        assert.ok(!/max-width/.test(query), `not mobile-first: ${query.trim()}`);
    }
});

test("the side gutter is set once, and never by a shorthand that could zero it", () => {
    // The page frame is inline, in every page's critical CSS, beside the header it lines up with.
    const container = criticalCss("home").match(/\.container\s*\{[^}]*\}/)!;
    assert.ok(container, ".container is defined");
    assert.ok(!/\.container\s*\{/.test(authoredCss()), "a second .container in the stylesheet would be a second place to set the gutter");
    assert.match(container[0], /padding-inline:\s*var\(--gutter\)/);
    assert.ok(!/\bpadding:\s/.test(container[0]), ".container must not use the padding shorthand");
    assert.match(container[0], /padding-block:/);
});

test("reduced motion is honoured, and every animation the site has is one it stops", () => {
    const css = authoredCss();
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    // Named rather than counted, so adding one is a decision about whether it stops, not a number to
    // bump. Every one of these is decorative: the colour and the text carry the meaning without them.
    const animations = [...css.matchAll(/@keyframes\s+([a-z-]+)/g)].map(m => m[1]).sort();
    // The demo's status is a still bullet, so the live dot no longer pulses; only the skeleton sweeps.
    assert.deepEqual(animations, ["nr-skeleton"]);

    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(reduced, /animation-duration:\s*\.001ms\s*!important/,
        "the blanket rule stops every animation, including any added later");
    // ONE SHOT's screen shake is drawn on its canvas, not animated here; one-shot.test.ts holds it to the
    // same preference.
});

test("every page-kind rule a page inlines is, word for word, a rule of the stylesheet", () => {
    // The critical CSS paints the first frame and the stylesheet paints the rest; a rule that said one
    // thing inline and another in the stylesheet would make the page change under the reader.
    const squash = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ")
        .replace(/\s*([{};:,>])\s*/g, "$1").replace(/;\}/g, "}").replace(/@media \(/g, "@media(").trim();
    const sheet = squash(authoredCss());
    for (const [kind, block] of Object.entries(CRITICAL_PAGE_RULES)) {
        // A media block is compared rule by rule: the stylesheet may hold more under the same query.
        const flat = squash(block).replace(/@media\([^)]*\)\{((?:[^{}]*\{[^}]*\})*)\}/g, "$1");
        const rules = flat.match(/[^{}]+\{[^}]*\}/g) ?? [];
        assert.ok(rules.length > 3, `${kind}: expected rules to compare`);
        for (const rule of rules) {
            assert.ok(sheet.includes(rule), `${kind}: the stylesheet does not carry the inlined rule ${rule}`);
        }
    }
});

test("a link is identifiable at rest, not only under a pointer", () => {
    // Codex P2 on #63: the demo draws a timeline label white and bold, and a label that links to its
    // evidence looked exactly like one that does not until hovered — which a phone never does.
    const css = authoredCss().replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(css, /\.event-label a,\s*\.data-label a\s*\{[^}]*text-decoration:\s*underline/, "evidence links are not underlined at rest");
    assert.match(css, /\.footer-links a\s*\{[^}]*text-decoration:\s*underline/, "the footer's links are not underlined at rest");
});

test("keyboard focus is visible", () => {
    assert.match(authoredCss(), /:focus-visible\s*\{[^}]*outline:/);
});

test("interactive targets declare the 44px minimum", () => {
    const css = authoredCss();
    // The footer's twelve tracker links are the smallest targets on the site; on a phone they stack so
    // each one is a full row.
    const footerNav = css.match(/\.footer-nav a,\s*\.footer-nav \[aria-current="page"\]\s*\{[^}]*\}/)!;
    assert.ok(footerNav, ".footer-nav links are defined");
    assert.match(footerNav[0], /min-height:\s*var\(--tap\)/);
    assert.equal(TOKEN["--tap"], "44px");
});

test("the dead rules of three earlier designs are gone", () => {
    // Left behind by the console-hub design and by the ad slots this repository removed. Every one had
    // no markup anywhere in the site, and `.ad-slot` drew a dashed box captioned "Advertisement" for
    // an ad unit that does not exist and must not come back.
    const css = authoredCss();
    for (const gone of [".ad-slot", ".pill", ".timer", ".mini", ".hr", ".trust-box", ".trust-item"]) {
        assert.ok(!css.includes(gone + "{") && !css.includes(gone + " {") && !css.includes(gone + ","),
            `${gone} is still styled but nothing uses it`);
    }
    for (const page of PAGES) {
        assert.ok(!read(page).includes("ad-slot"), `${page} still references an ad slot`);
    }
});

test("the served stylesheet keeps every rule and none of the prose", () => {
    const min = minifyCss(STYLESHEET);
    assert.equal((min.match(/\/\*/g) || []).length, 0, "comments are not shipped");
    assert.equal(
        (min.match(/\{/g) || []).length,
        (STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, "").match(/\{/g) || []).length,
        "every rule survived"
    );
    assert.equal((min.match(/@media/g) || []).length, (STYLESHEET.match(/@media/g) || []).length);
    assert.equal((min.match(/@keyframes/g) || []).length, (STYLESHEET.match(/@keyframes/g) || []).length);
    assert.ok(min.length < STYLESHEET.length, "and it is smaller");
});

test("a comment containing an apostrophe does not swallow the file", () => {
    // The bug this test exists for: stripping strings and comments in two passes let "every page's
    // critical CSS" open a string that ran to the next apostrophe, taking the comment's terminator with
    // it — so the whole comment shipped, and the rules after it were mangled.
    const css = `/* every page's critical CSS */\n.a { color: red; }\n/* it's fine */\n.b { color: blue; }`;
    const min = minifyCss(css);
    assert.equal(min, ".a{color: red}.b{color: blue}");
});

test("slash-star inside a string does not open a comment", () => {
    // And the same mistake the other way round.
    const css = `.a::after { content: "/* not a comment */"; color: red; }`;
    assert.equal(minifyCss(css), `.a::after{content: "/* not a comment */";color: red}`);
});

test("minifying never touches what is inside a string", () => {
    const css = `.a::after { content: ' \\26A0'; font-family: "Segoe UI", sans-serif; }`;
    const min = minifyCss(css);
    assert.ok(min.includes(`' \\26A0'`), "an escape keeps its space");
    assert.ok(min.includes(`"Segoe UI"`), "a quoted font name keeps its space");
});

test("minifying leaves the spaces that carry meaning", () => {
    assert.ok(minifyCss("@media (min-width: 768px) { .a { color: red; } }").includes("min-width: 768px"));
    assert.ok(minifyCss(".a > .b { color: red }").includes(".a > .b"), "a combinator keeps its room");
    assert.ok(minifyCss(".a { margin: 0 auto }").includes("0 auto"), "a value list keeps its spaces");
});

test("minifying is idempotent", () => {
    const once = minifyCss(STYLESHEET);
    assert.equal(minifyCss(once), once);
});

test("the tokenizer reads comments and strings in source order", () => {
    const runs = tokenize(`.a{content:"x"}/* c */`);
    assert.deepEqual(runs.map(r => r.kind), ["code", "string", "code", "comment"]);
    // An unterminated comment ends at the file rather than running off it.
    assert.deepEqual(tokenize("/* open").map(r => r.kind), ["comment"]);
});

test("the classes the renderers emit are all styled", () => {
    // The build writes these into the page; a redesign that renamed a rule would leave them unstyled,
    // and nothing else would notice.
    const css = STYLESHEET;
    const emitted = [
        "card", "card-header", "card-title", "card-topic", "card-countdown", "card-meta", "is-text",
        "badge-live", "badge-stale", "badge-unavailable", "group-heading",
        "countdown-box", "countdown-label", "countdown-value", "unavailable", "stale", "elapsed",
        "info-panel", "info-row", "info-label", "info-value",
        "confidence", "confidence-high", "confidence-medium", "confidence-none",
        "notes", "breadcrumbs", "crumb-sep", "footer-nav", "kicker",
        "data-note", "data-list", "data-row", "data-label", "data-when", "data-quote",
        "countdown-skeleton", "unit", "error", "content-section", "faq-item", "noscript-note"
    ];
    for (const name of emitted) {
        assert.ok(new RegExp(`\\.${name}[\\s,.:{\\[]`).test(css), `.${name} is emitted by the build but has no rule`);
    }
});
