/**
 * Publishing V2, milestone 5: how the site is put together.
 *
 * Every page used to be reachable only from the homepage, said nothing about where it sat, and appeared
 * in a hand-written sitemap that carried the two hints Google ignores and not the one it reads. These
 * tests hold the pieces to each other: the sitemap lists the pages that exist at the URLs they declare
 * as canonical, the breadcrumb a reader sees is the breadcrumb the markup claims, and the footer names
 * every tracker the site actually has.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { GameKnowledge } from "../../render-data-blocks";
import { trackerOf } from "../../render-pages";
import { buildSitemap, factsChangedAt, sitemapEntries, urlPathOf } from "../../render-sitemap";
import { gamePages } from "../../update-game-pages";
import { GAMES } from "../games";

const ROOT = path.join(__dirname, "..", "..", "..");
const PUBLIC = path.join(ROOT, "public");
const ORIGIN = "https://nextreset.co";

function authoredPages(): string[] {
    const pages: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === "index.html") pages.push(path.relative(PUBLIC, full).replace(/\\/g, "/"));
        }
    };
    walk(PUBLIC);
    return pages.sort();
}

const PAGES = authoredPages();
const load = (page: string) => cheerio.load(fs.readFileSync(path.join(PUBLIC, page), "utf8"));

test("a page's place in the build is its URL", () => {
    assert.equal(urlPathOf("index.html"), "/");
    assert.equal(urlPathOf("lol/next-patch/index.html"), "/lol/next-patch/");
    assert.equal(urlPathOf("about/index.html"), "/about/");
});

test("a page is dated by when its facts changed, not by when it was last checked", () => {
    const knowledge: GameKnowledge = {
        game: "lol",
        events: [
            { key: "lol/next-patch/26.19", topic: "next-patch", label: "26.19", status: "observed", at: "2026-09-23T00:00:00.000Z", firstSeen: "2026-09-01T10:00:00.000Z", lastVerified: "2026-09-16T21:24:00.000Z", publishState: "published" },
            { key: "lol/next-patch/26.20", topic: "next-patch", label: "26.20", status: "observed", at: "2026-10-07T00:00:00.000Z", firstSeen: "2026-09-04T10:00:00.000Z", lastVerified: "2026-09-16T21:24:00.000Z", publishState: "published" }
        ],
        claims: [
            { eventKey: "lol/next-patch/26.19", field: "at", value: "2026-09-23T00:00:00.000Z", extractedAt: "2026-09-01T10:00:00.000Z" },
            { eventKey: "lol/next-patch/26.20", field: "at", value: "2026-10-07T00:00:00.000Z", extractedAt: "2026-09-06T11:00:00.000Z" }
        ]
    };

    // The newest moment a fact appeared or was stated — not either event's lastVerified, which moves
    // every six hours whether or not anything changed.
    assert.equal(factsChangedAt(knowledge, "next-patch"), "2026-09-06T11:00:00.000Z");
    assert.equal(factsChangedAt(knowledge, "last-patch"), undefined, "a topic with no published events cannot be dated");
    assert.equal(factsChangedAt(undefined, "next-patch"), undefined, "nor can a game with no knowledge file");

    // A held event is ours to know, not to publish, so it cannot date a page either.
    const held: GameKnowledge = { game: "lol", events: [{ ...knowledge.events![0], firstSeen: "2027-01-01T00:00:00.000Z", publishState: "held" }], claims: [] };
    assert.equal(factsChangedAt(held, "next-patch"), undefined);
});

test("the sitemap carries the one hint Google reads and none of the ones it ignores", () => {
    const xml = buildSitemap([
        { loc: "https://nextreset.co/", lastmod: "2026-09-06T11:00:00.000Z" },
        { loc: "https://nextreset.co/about/" }
    ]);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.ok(xml.includes("<loc>https://nextreset.co/</loc>"));
    assert.ok(xml.includes("<lastmod>2026-09-06T11:00:00.000Z</lastmod>"));
    assert.ok(xml.includes("<loc>https://nextreset.co/about/</loc>\n  </url>"), "a page that cannot be dated carries no date");
    assert.ok(!xml.includes("changefreq") && !xml.includes("priority"), "neither hint is read, so neither is published");
    assert.ok(!/<lastmod><\/lastmod>/.test(xml), "and an empty element is never emitted");
});

test("the homepage is as new as the newest thing on it", () => {
    const knowledge: Record<string, GameKnowledge> = {
        lol: { game: "lol", events: [{ key: "k1", topic: "next-patch", label: "26.19", status: "observed", at: "2026-09-23T00:00:00.000Z", firstSeen: "2026-09-02T00:00:00.000Z", publishState: "published" }], claims: [] },
        cs2: { game: "cs2", events: [{ key: "k2", topic: "last-update", label: "Update", status: "observed", at: "2026-09-09T00:00:00.000Z", firstSeen: "2026-09-10T00:00:00.000Z", publishState: "published" }], claims: [] }
    };
    const entries = sitemapEntries(
        [
            { page: "lol/next-patch/index.html", tracker: { game: "lol", type: "next-patch" } },
            { page: "index.html" },
            { page: "cs2/last-update/index.html", tracker: { game: "cs2", type: "last-update" } },
            { page: "about/index.html" }
        ],
        ORIGIN,
        game => knowledge[game]
    );

    assert.deepEqual(entries.map(e => e.loc), [
        `${ORIGIN}/`,
        `${ORIGIN}/about/`,
        `${ORIGIN}/cs2/last-update/`,
        `${ORIGIN}/lol/next-patch/`
    ], "the homepage first, then a stable order");
    assert.equal(entries[0].lastmod, "2026-09-10T00:00:00.000Z", "the newest of its trackers");
    assert.equal(entries[1].lastmod, undefined, "a static page is left undated rather than guessed at");
});

test("a page that is not submitted still dates the homepage it appears on", () => {
    // The homepage renders every tracker's card, including one carrying noindex. Dropping that
    // tracker's facts along with its URL would let the homepage's date go stale behind a value it is
    // showing — or leave it undated entirely, if the noindexed tracker is the only dated one.
    const knowledge: Record<string, GameKnowledge> = {
        lol: { game: "lol", events: [{ key: "k1", topic: "next-patch", label: "26.19", status: "scheduled", at: "2026-09-23T00:00:00.000Z", firstSeen: "2026-09-02T00:00:00.000Z", publishState: "published" }], claims: [] },
        fortnite: { game: "fortnite", events: [{ key: "k2", topic: "next-season", label: "Season 9", status: "scheduled", at: "2026-06-06T00:00:00.000Z", firstSeen: "2026-09-14T00:00:00.000Z", publishState: "published" }], claims: [] }
    };
    const entries = sitemapEntries(
        [
            { page: "index.html", listed: true },
            { page: "lol/next-patch/index.html", tracker: { game: "lol", type: "next-patch" }, listed: true },
            { page: "fortnite/next-season/index.html", tracker: { game: "fortnite", type: "next-season" }, listed: false }
        ],
        ORIGIN,
        game => knowledge[game]
    );

    assert.deepEqual(entries.map(e => e.loc), [`${ORIGIN}/`, `${ORIGIN}/lol/next-patch/`], "the unsubmitted page is not listed");
    assert.equal(entries[0].lastmod, "2026-09-14T00:00:00.000Z", "but it is still the newest thing the homepage shows");
});

test("every page in the sitemap is a page that exists, at the URL it calls canonical", () => {
    const inputs = PAGES.map(page => {
        const html = fs.readFileSync(path.join(PUBLIC, page), "utf8");
        return { page, tracker: trackerOf(html, page) };
    });
    const entries = sitemapEntries(inputs, ORIGIN, () => undefined);
    assert.equal(entries.length, PAGES.length);
    assert.ok(PAGES.length >= 15, `expected every authored page, found ${PAGES.length}`);

    for (const page of PAGES) {
        const canonical = load(page)(`link[rel="canonical"]`).attr("href");
        assert.ok(canonical, `${page} has no canonical`);
        assert.equal(canonical, `${ORIGIN}${urlPathOf(page)}`, `${page}: canonical and location disagree`);
        assert.ok(entries.some(entry => entry.loc === canonical), `${page} is not in the sitemap`);
    }
});

test("every page says where it sits, and its markup says the same thing", () => {
    for (const page of PAGES) {
        const $ = load(page);
        const crumbs = $(".breadcrumbs");
        if (page === "index.html") {
            assert.equal(crumbs.length, 0, "the homepage is the root; it has nowhere to point back to");
            continue;
        }
        assert.equal(crumbs.length, 1, `${page} has no breadcrumb`);
        assert.equal(crumbs.find("a").attr("href"), "/", `${page}: the first crumb goes home`);
        const here = crumbs.find(`[aria-current="page"]`).text().trim();
        assert.ok(here.length > 0, `${page}: the current page is not named`);

        const schemas = $(`script[type="application/ld+json"]`).toArray()
            .map(node => JSON.parse($(node).html() ?? "{}"))
            .filter(schema => schema["@type"] === "BreadcrumbList");
        assert.equal(schemas.length, 1, `${page}: expected exactly one BreadcrumbList`);
        const items = schemas[0].itemListElement;
        assert.deepEqual(items.map((i: { position: number }) => i.position), [1, 2], `${page}: positions run from one`);
        assert.equal(items[0].item, `${ORIGIN}/`);
        assert.equal(items[1].name, here, `${page}: the markup claims a crumb the page does not show`);
        assert.equal(items[1].item, undefined, "the page you are on is not a link to itself");
    }
});

test("every tracker is reachable from every page", () => {
    const expected = gamePages.map(page => `/${page.game}/${page.type}/`).sort();
    assert.equal(expected.length, 12);

    for (const page of PAGES) {
        if (page === "index.html") continue; // the homepage lists them in its own words
        const $ = load(page);
        const nav = $(".footer-nav");
        assert.equal(nav.length, 1, `${page} has no tracker navigation`);

        const links = nav.find("a").toArray().map(a => $(a).attr("href")!);
        const current = nav.find(`[aria-current="page"]`);
        assert.equal(current.length <= 1, true, `${page}: at most one current page`);
        const listed = [...links, ...(current.length ? [`/${page.replace(/index\.html$/, "")}`] : [])].sort();

        if (trackerOf(fs.readFileSync(path.join(PUBLIC, page), "utf8"), page)) {
            assert.deepEqual(listed, expected, `${page}: the footer does not name every tracker exactly once`);
            assert.equal(current.length, 1, `${page}: a tracker page does not link to itself`);
        } else {
            assert.deepEqual(links.sort(), expected, `${page}: the footer does not name every tracker`);
        }

        for (const href of links) {
            assert.ok(fs.existsSync(path.join(PUBLIC, href.replace(/^\//, ""), "index.html")), `${page}: ${href} does not exist`);
        }
    }
});

test("the sitemap is built, never authored, so it cannot drift from the pages", () => {
    // It used to be a hand-written file listing fifteen URLs. Keeping a copy in public/ would mean two
    // sitemaps, and the stale one would be the one nobody remembered to update.
    assert.equal(fs.existsSync(path.join(PUBLIC, "sitemap.xml")), false);
});

test("a URL that does not exist has a page of its own", () => {
    // Every unknown path was answering 200 with the homepage, which tells a crawler that an unbounded
    // number of invented URLs are real pages — all of them the homepage. Cloudflare Pages serves a
    // 404.html from the build root with a real 404 status.
    const file = path.join(PUBLIC, "404.html");
    assert.ok(fs.existsSync(file), "the site has no page for a URL that does not exist");
    const $ = cheerio.load(fs.readFileSync(file, "utf8"));

    assert.equal($(`meta[name="robots"]`).attr("content"), "noindex, follow");
    assert.equal($("h1").length, 1);
    assert.ok($(`a[href="/"]`).length >= 1, "a lost visitor is offered the way home");
    assert.equal($(`link[rel="canonical"]`).length, 0, "a page that is not a page has no canonical");

    // It is not a page, so it is not one of the pages: absent from the sitemap and from the breadcrumb
    // trail, but still offering every tracker.
    assert.ok(!PAGES.includes("404.html"), "it is not an index.html and so is never listed");
    assert.equal($(".breadcrumbs").length, 0, "it sits nowhere in the hierarchy");
    const links = $(".footer-nav a").toArray().map(a => $(a).attr("href")!).sort();
    assert.deepEqual(links, gamePages.map(page => `/${page.game}/${page.type}/`).sort(), "every tracker is reachable from it");
});

test("the documented sources are the sources the code actually reads", () => {
    // The table described V1 providers long after ten of the twelve moved to V2 — RSS for Counter-Strike
    // that is now a JSON API, an HTML scrape for Minecraft that is now Mojang's manifest. Checking that
    // the game names appear would not have caught any of that, so each row is checked against the
    // registry entry it describes.
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const table = readme.slice(readme.indexOf("| Game | Question |"));
    const rows = table.slice(0, table.indexOf("\r\n\r\n")).split(/\r?\n/)
        .filter(line => line.startsWith("|"))
        .slice(2)
        .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));

    assert.equal(rows.length, gamePages.length, "every tracker the site publishes has a row");
    const rowFor = (title: string) => {
        const found = rows.filter(cells => cells[0] === title);
        assert.equal(found.length, 1, `expected exactly one row for ${title}`);
        return { question: found[0][1], source: found[0][2], how: found[0][3] };
    };

    /** What the registry says a source is, as the table would have to describe it. */
    const expectedMethod: Record<string, string> = { json: "JSON", html: "HTML", rule: "Computed" };

    for (const entry of GAMES) {
        const page = gamePages.find(candidate => candidate.game === entry.id);
        assert.ok(page, `the registry has ${entry.id} but no page does`);
        const row = rowFor(page!.title);
        // The question cell is a label, and the site words it differently in different places on
        // purpose — "Banner end" on a card, "Next Banner End" as a page heading — so only its
        // presence is checked. What must not drift is the source and how it is read.
        assert.ok(row.question.length > 0, `${page!.title}: the row does not say what question it answers`);

        const kinds = [...new Set(entry.sources.map(source => source.kind))];
        assert.equal(kinds.length, 1, `${entry.id}: expected one kind of source, found ${kinds.join("+")}`);

        // Only a tracker with a discovery configuration reads prose with a model; everything else is
        // parsed, and the table has to say which of the two this is.
        const usesModel = entry.topics.some(topic => !!topic.discovery);
        assert.equal(/\bAI\b|model/i.test(row.how), usesModel, `${page!.title}: the row disagrees about whether a model reads it`);
        if (!usesModel) {
            assert.match(row.how, new RegExp(expectedMethod[kinds[0]]), `${page!.title}: the registry reads ${kinds[0]}`);
        }
        assert.ok(!/V1 provider/.test(row.how), `${page!.title} is on V2, so the row must not call it a V1 provider`);
    }

    // The two the registry does not cover are the two still on their V1 provider, and say so.
    const onV2 = new Set(GAMES.map(entry => entry.id));
    for (const page of gamePages.filter(candidate => !onV2.has(candidate.game))) {
        assert.match(rowFor(page.title).how, /V1 provider/, `${page.title} is not on V2 and the row should say so`);
    }
    assert.equal(gamePages.length - onV2.size, 2, "ten of the twelve are on V2");
});

test("the crawl rules still keep the data files out and point at the sitemap", () => {
    const robots = fs.readFileSync(path.join(PUBLIC, "robots.txt"), "utf8");
    assert.match(robots, /^Disallow: \/data\/$/m, "the JSON the pages read is not for the index");
    assert.match(robots, /^Sitemap: https:\/\/nextreset\.co\/sitemap\.xml$/m);
    assert.match(robots, /^Allow: \/$/m);
});
