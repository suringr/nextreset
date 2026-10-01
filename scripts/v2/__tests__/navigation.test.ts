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
import * as os from "os";
import * as path from "path";
import { EDITORIAL_NOINDEX, NOINDEX_TAG, isListed } from "../../indexing";
import { GameKnowledge } from "../../render-data-blocks";
import { TrackerData, pageIdentityOf, renderSite, renderTrackerHtml, trackerOf } from "../../render-pages";
import { buildSitemap, factsChangedAt, sitemapEntries, urlPathOf } from "../../render-sitemap";
import { SITE_PAGES, matchesDirectory, pageEntry, trackerPages as trackerManifest } from "../../site-map";
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

/** A pinned clock, and two trackers that answer — so only the editorial rule can withhold either. */
const NOW = new Date("2026-09-16T12:00:00Z");
const ROBLOX_ANSWERED: TrackerData = {
    game: "roblox", type: "status", status: "fresh", nextEventUtc: "2026-09-16T02:18:42.170Z",
    precision: "exact", fetched_at_utc: "2026-09-16T11:00:00.000Z",
    last_success_at_utc: "2026-09-16T11:00:00.000Z", source_url: "https://status.roblox.com", confidence: "high"
};
const LOL_ANSWERED: TrackerData = { ...ROBLOX_ANSWERED, game: "lol", type: "next-patch", nextEventUtc: "2026-09-23T00:00:00.000Z", precision: "day" };

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
    // What this used to assert with ">= 15" — that the walk really found the site, rather than an empty
    // directory that would make every loop below vacuous.
    const { undeclared, missing } = matchesDirectory(PUBLIC);
    assert.deepEqual([...undeclared, ...missing], [], "the directory and scripts/site-map.ts disagree");

    for (const page of PAGES) {
        const canonical = load(page)(`link[rel="canonical"]`).attr("href");
        assert.ok(canonical, `${page} has no canonical`);
        assert.equal(canonical, `${ORIGIN}${urlPathOf(page)}`, `${page}: canonical and location disagree`);
        assert.ok(entries.some(entry => entry.loc === canonical), `${page} is not in the sitemap`);
    }
});

/**
 * /play/ is the one page with neither a breadcrumb nor a footer, and it is named rather than matched.
 *
 * It is ONE SHOT, a full-screen game that does not scroll — the owner approved it that way — so there is
 * nowhere below the game to put either. It is `noindex`, and its shared header's "Trackers" link reaches
 * every tracker in one tap. A second page without them would have to be added here, on purpose.
 */
const FULL_SCREEN = "play/index.html";

test("the full-screen game is the only page excused, and it still reaches the trackers", () => {
    const $ = load(FULL_SCREEN);
    assert.equal($(".breadcrumbs").length, 0);
    assert.equal($(".footer-nav").length, 0);
    assert.equal($('header.chrome a[href="/#all-games"]').length, 1, "no way from the game to the trackers");
    assert.equal($('meta[name="robots"]').attr("content"), "noindex, follow");
});

test("every page says where it sits, and its markup says the same thing", () => {
    for (const page of PAGES) {
        const $ = load(page);
        const crumbs = $(".breadcrumbs");
        if (page === "index.html") {
            assert.equal(crumbs.length, 0, "the homepage is the root; it has nowhere to point back to");
            continue;
        }
        if (page === FULL_SCREEN) continue;
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

test("every listed tracker is reachable from every page, and no withheld one is", () => {
    // The footer names the trackers worth reading, not every tracker that exists. A page withheld from
    // the index (EDITORIAL_NOINDEX) is not advertised from fifteen other pages — that would be fifteen
    // invitations to the page we rated lowest, and fifteen crawl paths into it.
    const expected = gamePages.filter(page => isListed(page.path)).map(page => `/${page.game}/${page.type}/`).sort();
    const withheld = gamePages.filter(page => !isListed(page.path)).map(page => `/${page.game}/${page.type}/`);
    assert.equal(expected.length + withheld.length, gamePages.length);
    assert.ok(expected.length > 0 && withheld.length > 0, "this test is only meaningful with some of each");

    for (const page of PAGES) {
        if (page === "index.html") continue; // the homepage lists them in its own words
        if (page === FULL_SCREEN) continue;  // see FULL_SCREEN: one tap away through the header
        const $ = load(page);
        const nav = $(".footer-nav");
        assert.equal(nav.length, 1, `${page} has no tracker navigation`);

        const links = nav.find("a").toArray().map(a => $(a).attr("href")!);
        const current = nav.find(`[aria-current="page"]`);
        assert.equal(current.length <= 1, true, `${page}: at most one current page`);
        const named = [...links, ...(current.length ? [`/${page.replace(/index\.html$/, "")}`] : [])].sort();

        const self = `/${page.replace(/index\.html$/, "")}`;
        if (expected.includes(self)) {
            assert.deepEqual(named, expected, `${page}: the footer does not name every listed tracker exactly once`);
            assert.equal(current.length, 1, `${page}: a listed tracker page does not link to itself`);
        } else {
            // Every other page — the static pages, the 404, and a withheld tracker's own page — links to
            // the listed set and names nothing as current.
            assert.deepEqual(links.sort(), expected, `${page}: the footer does not name every listed tracker`);
            assert.equal(current.length, 0, `${page}: nothing here is the current tracker`);
        }

        for (const href of withheld) {
            assert.ok(!links.includes(href), `${page}: links to ${href}, which is withheld from the index`);
        }
        for (const href of links) {
            assert.ok(fs.existsSync(path.join(PUBLIC, href.replace(/^\//, ""), "index.html")), `${page}: ${href} does not exist`);
        }
    }
});

test("the manifest's trackers are the registry's trackers, and the pages' own", () => {
    // Codex, PR #64: the game/type on each manifest entry was read by nothing, so a typo in it could
    // not fail. It is checked against both of the other places the same pair is written — the tracker
    // registry, and what each authored page says about itself — so the three cannot drift apart.
    const manifest = trackerManifest();
    assert.deepEqual(
        manifest.map(entry => `${entry.tracker!.game}/${entry.tracker!.type}`).sort(),
        gamePages.map(entry => `${entry.game}/${entry.type}`).sort(),
        "the manifest and the tracker registry disagree about which trackers exist"
    );
    for (const entry of manifest) {
        assert.ok(entry.tracker, `${entry.page} is declared a tracker with no game/type`);
        const html = fs.readFileSync(path.join(PUBLIC, entry.page), "utf8");
        assert.deepEqual(trackerOf(html, entry.page), entry.tracker, `${entry.page}: the page and the manifest disagree`);
        assert.equal(`${entry.tracker.game}/${entry.tracker.type}/index.html`, entry.page, `${entry.page}: path and tracker disagree`);
    }
    // Nothing that is not a tracker claims one.
    for (const entry of SITE_PAGES.filter(e => e.role !== "tracker")) {
        assert.equal(entry.tracker, undefined, `${entry.page} is not a tracker but carries tracker metadata`);
    }
});

test("a page is withheld by what its canonical says it is, not by the label a caller passed", () => {
    // Codex, PR #64: the editorial list used to be looked up by the `page` argument, which is a label
    // for error messages that callers spell however reads best ("fortnite/next-season", or just
    // "page"). A withheld tracker rendered through such a call would have published as indexable.
    const roblox = fs.readFileSync(path.join(PUBLIC, "roblox/status/index.html"), "utf8");
    assert.equal(pageIdentityOf(roblox), "roblox/status/index.html", "a page is identified by its canonical");

    // The same HTML, rendered with three different labels, is withheld every time.
    for (const label of ["roblox/status", "page", "anything at all"]) {
        const out = renderTrackerHtml(roblox, ROBLOX_ANSWERED, label, NOW);
        assert.ok(out.includes(NOINDEX_TAG), `label ${JSON.stringify(label)} lost the withholding`);
    }
    // And a page that is not withheld does not gain the tag from a label that happens to name one.
    const lol = fs.readFileSync(path.join(PUBLIC, "lol/next-patch/index.html"), "utf8");
    assert.equal(pageIdentityOf(lol), "lol/next-patch/index.html");
    assert.ok(!renderTrackerHtml(lol, LOL_ANSWERED, "roblox/status/index.html", NOW).includes(NOINDEX_TAG));

    // Markup that names no page this site publishes is decided by its data alone.
    assert.equal(pageIdentityOf(`<link rel="canonical" href="https://nextreset.co/not-a-page/">`), undefined);
    assert.equal(pageIdentityOf("<html></html>"), undefined);
});

test("a canonical is read as markup, so valid spellings of it resolve the same page", () => {
    // Codex, PR #64 round 2: this was a regex, and `<link href="…" rel="canonical">` or single quotes
    // made it return undefined while cheerio — which the navigation test and the rest of the build use
    // — read them fine. A withheld page written that way would have lost its noindex tag while still
    // being dropped from the sitemap: neither submitted nor actually withheld.
    const page = "roblox/status/index.html";
    for (const markup of [
        `<link rel="canonical" href="https://nextreset.co/roblox/status/">`,
        `<link href="https://nextreset.co/roblox/status/" rel="canonical">`,
        `<link rel='canonical' href='https://nextreset.co/roblox/status/'>`,
        `<link REL="CANONICAL" HREF="https://nextreset.co/roblox/status/">`,
        `<link rel="canonical" href="/roblox/status/">`,
        `<link rel="canonical" href="https://nextreset.co/roblox/status">`
    ]) {
        assert.equal(pageIdentityOf(markup), page, `not resolved: ${markup}`);
    }
    // A canonical naming another site is not this page saying where it lives.
    assert.equal(pageIdentityOf(`<link rel="canonical" href="https://example.com/roblox/status/">`), undefined);
    assert.equal(pageIdentityOf(`<link rel="canonical" href="::::">`), undefined);
    // Two canonicals is not one statement of identity, and the build already refuses to render it.
    assert.equal(pageIdentityOf(`<link rel="canonical" href="/roblox/status/"><link rel='canonical' href='/lol/next-patch/'>`), undefined);
});

test("every canonical spelling the parser accepts, the noindex tag can be inserted after", () => {
    // Codex, PR #64 round 3: teaching pageIdentityOf these spellings without teaching the insertion the
    // same ones turned a silent mismatch into a build crash — the page resolved its identity, decided
    // noindex, then threw looking for a tag it had just read. Both now go through one reader.
    const roblox = fs.readFileSync(path.join(PUBLIC, "roblox/status/index.html"), "utf8");
    const authored = roblox.match(/<link rel="canonical"[^>]*>/)![0];

    for (const spelling of [
        `<link href="https://nextreset.co/roblox/status/" rel="canonical">`,
        `<link rel='canonical' href='https://nextreset.co/roblox/status/'>`,
        `<link REL="CANONICAL" HREF="https://nextreset.co/roblox/status/">`,
        `<link rel="canonical" href="/roblox/status/">`
    ]) {
        const html = roblox.replace(authored, spelling);
        assert.equal(pageIdentityOf(html), "roblox/status/index.html", `identity: ${spelling}`);
        const out = renderTrackerHtml(html, ROBLOX_ANSWERED, "roblox/status/index.html", NOW);
        assert.ok(out.includes(NOINDEX_TAG), `tag not inserted for: ${spelling}`);
        // And inserted after that tag, not somewhere else in the head.
        assert.ok(out.indexOf(NOINDEX_TAG) > out.indexOf(spelling), `tag inserted before the canonical: ${spelling}`);
    }

    // A page with no canonical, or two, refuses to render rather than guessing where the tag goes.
    // Driven with data that cannot answer, because that is what makes the tag necessary: without a
    // readable canonical the page has no identity, so the editorial list cannot reach it and only the
    // data rule can ask for the tag.
    const unanswered: TrackerData = { ...ROBLOX_ANSWERED, nextEventUtc: null };
    assert.throws(() => renderTrackerHtml(roblox.replace(authored, ""), unanswered, "roblox/status/index.html", NOW), /exactly one canonical/);
    assert.throws(() => renderTrackerHtml(roblox.replace(authored, authored + authored), unanswered, "roblox/status/index.html", NOW), /exactly one canonical/);
});

test("the sitemap and the noindex tag always answer about the same page", () => {
    // The failure this guards: a page excluded from the sitemap but rendered without its tag, or the
    // reverse. renderSite takes one decision per page and hands it to both, so the only way they can
    // disagree is if someone splits them again.
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-agree-"));
    for (const entry of trackerManifest()) {
        const dir = path.join(dist, path.dirname(entry.page));
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(PUBLIC, entry.page), path.join(dist, entry.page));
    }
    fs.mkdirSync(path.join(dist, "data"), { recursive: true });
    // Every tracker answers, so nothing here is withheld except by decision.
    for (const entry of trackerManifest()) {
        const { game, type } = entry.tracker!;
        fs.writeFileSync(path.join(dist, "data", `${game}.${type}.json`),
            JSON.stringify({ ...ROBLOX_ANSWERED, game, type, nextEventUtc: "2026-09-16T02:18:42.170Z" }));
    }
    const summary = renderSite(dist, NOW, dist);
    const submitted = new Set(summary.sitemap.map(e => e.loc));
    for (const entry of trackerManifest()) {
        const html = fs.readFileSync(path.join(dist, entry.page), "utf8");
        const tagged = html.includes(`content="noindex, follow"`);
        const listed = submitted.has(`https://nextreset.co${urlPathOf(entry.page)}`);
        assert.notEqual(tagged, listed, `${entry.page}: tagged=${tagged} but in sitemap=${listed}`);
        assert.equal(tagged, !isListed(entry.page), `${entry.page}: the tag disagrees with the editorial list`);
    }
    fs.rmSync(dist, { recursive: true, force: true });
});

test("a withheld tracker keeps its route, its data and its card — it only loses the index and the footer", () => {
    // The point of withholding rather than deleting. Each one is still a page a reader can open, still
    // has its provider in the registry, and is still declared by the manifest.
    for (const { page: file, reason } of EDITORIAL_NOINDEX) {
        assert.ok(fs.existsSync(path.join(PUBLIC, file)), `${file} was deleted rather than withheld`);
        assert.ok(pageEntry(file), `${file} is withheld but not declared in scripts/site-map.ts`);
        assert.equal(pageEntry(file)!.role, "tracker", `${file} is not a tracker`);
        assert.notEqual(reason.trim(), "", `${file}: a withheld page needs a reason`);
        assert.ok(gamePages.some(entry => entry.path === file), `${file} left the tracker registry`);
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
    assert.deepEqual(
        links,
        gamePages.filter(page => isListed(page.path)).map(page => `/${page.game}/${page.type}/`).sort(),
        "every listed tracker is reachable from it"
    );
});

test("the documented sources are the sources the code actually reads", () => {
    // The table described V1 providers long after ten of the twelve moved to V2 — RSS for Counter-Strike
    // that is now a JSON API, an HTML scrape for Minecraft that is now Mojang's manifest. Checking that
    // the game names appear would not have caught any of that, so each row is checked against the
    // registry entry it describes.
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    // The file is stored with CRLF and checked out with LF in CI, so the blank line that ends the table
    // has to be matched either way; splitting on "\r\n\r\n" alone reads the rest of the README in CI.
    const table = readme.slice(readme.indexOf("| Game | Question |")).split(/\r?\n\s*\r?\n/)[0];
    const rows = table.split(/\r?\n/)
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

    /** The publisher in a source URL: "api.steampowered.com" -> "steampowered". */
    const publisherOf = (url: string) => {
        const host = new URL(url).hostname.replace(/^www\./, "").split(".");
        return (host.length > 1 ? host[host.length - 2] : host[0]).toLowerCase();
    };

    /**
     * What a row may call each publisher.
     *
     * Spelled out rather than inferred: matching on shared substrings accepted "status.roblox.com" for
     * a source that is actually hostedstatus.com, and would have accepted statuspage.io just as
     * happily. A publisher with no entry here fails, so a new source cannot pass by being unknown.
     */
    const PUBLISHER_NAMES: Record<string, string[]> = {
        steampowered: ["steam"],
        riotgames: ["riot"],
        playvalorant: ["valorant"],
        callofduty: ["callofduty"],
        mojang: ["mojang"],
        hoyoverse: ["hoyoverse"],
        rockstargames: ["rockstar"],
        hostedstatus: ["hostedstatus"],
        fortnite: ["fortnite", "epic"]
    };

    /** Whether a prose description names that publisher, ignoring spacing and punctuation. */
    const names = (description: string, publisher: string) => {
        const accepted = PUBLISHER_NAMES[publisher];
        assert.ok(accepted, `no documented name for ${publisher}: add it to PUBLISHER_NAMES`);
        const flattened = description.toLowerCase().replace(/[^a-z]/g, "");
        return [publisher, ...accepted].some(name => flattened.includes(name));
    };

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

        // The row must name the publisher the registry actually reads, so swapping one real source for
        // another real one — a Steam feed described as Mojang's manifest — does not pass.
        const urls = entry.sources.map(source => source.url).filter(url => /^https?:/.test(url));
        if (urls.length > 0) {
            const publishers = [...new Set(urls.map(publisherOf))];
            assert.ok(
                publishers.some(publisher => names(row.source, publisher)),
                `${page!.title}: the row says "${row.source}" but the registry reads ${publishers.join(", ")}`
            );
        }

        // Only a tracker with a discovery configuration reads prose with a model; everything else is
        // parsed, and the table has to say which of the two this is.
        const usesModel = entry.topics.some(topic => !!topic.discovery);
        assert.equal(/\bAI\b|model/i.test(row.how), usesModel, `${page!.title}: the row disagrees about whether a model reads it`);
        if (!usesModel) {
            assert.match(row.how, new RegExp(expectedMethod[kinds[0]]), `${page!.title}: the registry reads ${kinds[0]}`);
        }
        assert.ok(!/V1 provider/.test(row.how), `${page!.title} is on V2, so the row must not call it a V1 provider`);
    }

    // The two the registry does not cover are the two still on their V1 provider. Their rows are held to
    // the same standard, against the URLs in the provider that fetches them: a V1 row is documentation
    // too, and "V1 provider" in the method cell says nothing about where the value comes from.
    const onV2 = new Set(GAMES.map(entry => entry.id));
    const v1Providers: Record<string, string> = { fortnite: "fortnite.ts", "red-dead-redemption-2": "rdr2.ts" };
    for (const page of gamePages.filter(candidate => !onV2.has(candidate.game))) {
        const row = rowFor(page.title);
        assert.match(row.how, /V1 provider/, `${page.title} is not on V2 and the row should say so`);

        const provider = v1Providers[page.game];
        assert.ok(provider, `${page.game} is on neither the registry nor a known V1 provider`);
        const source = fs.readFileSync(path.join(ROOT, "scripts", "providers", provider), "utf8");
        const publishers = [...new Set([...source.matchAll(/https?:\/\/[^"'`\s)]+/g)].map(match => publisherOf(match[0])))];
        assert.ok(publishers.length > 0, `${provider} fetches nothing`);
        assert.ok(
            publishers.some(publisher => names(row.source, publisher)),
            `${page.title}: the row says "${row.source}" but ${provider} fetches ${publishers.join(", ")}`
        );
    }
    assert.equal(gamePages.length - onV2.size, 2, "ten of the twelve are on V2");
});

test("the crawl rules still keep the data files out and point at the sitemap", () => {
    const robots = fs.readFileSync(path.join(PUBLIC, "robots.txt"), "utf8");
    assert.match(robots, /^Disallow: \/data\/$/m, "the JSON the pages read is not for the index");
    assert.match(robots, /^Sitemap: https:\/\/nextreset\.co\/sitemap\.xml$/m);
    assert.match(robots, /^Allow: \/$/m);
});
