import test from "node:test";
import assert from "node:assert/strict";
import { DuckDuckGoSearch, parseDuckDuckGoResults, resolveResultLink } from "../discovery/duckduckgo";
import { extractLinks, officialLinks } from "../discovery/links";
import { SearchUnavailableError, readSearchConfig } from "../discovery/search-provider";
import { SeedPageSearch } from "../discovery/seed";
import { SitemapSearch, parseSitemap, sitemapUrlsFromRobots } from "../discovery/sitemap";
import { validateContent } from "../fetch/content-validation";
import { LOL_NOTES_LISTING_URL, LOL_SCHEDULE_URL } from "./discovery-fixtures";
import { fakeTransport, fixture } from "./fake-transport";
import { routedTransport } from "./routed-transport";

test("DuckDuckGo result pages parse into canonical URLs, titles and snippets", () => {
    const { results, challenge } = parseDuckDuckGoResults(fixture("duckduckgo-riot-patch-schedule.html"));
    assert.equal(challenge, false);
    assert.equal(results.length, 10);
    assert.equal(results[0].url, LOL_SCHEDULE_URL);
    assert.match(results[0].title, /Patch Schedule - League of Legends Support/);
    assert.match(results[0].snippet ?? "", /periodically releases patches/);
    assert.deepEqual(results.map(r => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(resolveResultLink("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&rut=abc"), "https://example.com/a?x=1");
    assert.equal(resolveResultLink("https://duckduckgo.com/y.js?ad=1"), undefined, "links that stay on the engine are not results");
    const ads = parseDuckDuckGoResults(`<div class="result result--ad"><a class="result__a" href="https://ad.example/x">Ad</a></div><div class="result"><a class="result__a" href="https://example.com/x">X</a></div>`);
    assert.deepEqual(ads.results.map(r => r.url), ["https://example.com/x"]);
});

test("a DuckDuckGo challenge is a clean failure that disables web search for the run", async () => {
    const transport = fakeTransport({ http: [{ status: 202, body: fixture("duckduckgo-challenge.html") }] });
    const sleeps: number[] = [];
    const provider = new DuckDuckGoSearch({ transport, minIntervalMs: 0, sleep: async ms => { sleeps.push(ms); } });
    await assert.rejects(provider.search({ text: "League of Legends patch schedule", site: "riotgames.com" }), (e: unknown) => e instanceof SearchUnavailableError && e.code === "challenge");
    assert.equal(transport.gets.length, 1);
    assert.match(transport.gets[0].url, /html\.duckduckgo\.com\/html\/\?q=site%3Ariotgames\.com%20League%20of%20Legends/);
    await assert.rejects(provider.search({ text: "again" }), (e: unknown) => e instanceof SearchUnavailableError && e.code === "disabled");
    assert.equal(transport.gets.length, 1, "no further request after a challenge");
    assert.ok(provider.disabled);

    // The per-run budget and the spacing between queries are enforced.
    const ok = fakeTransport({ http: [{ status: 200, body: fixture("duckduckgo-riot-patch-schedule.html") }] });
    let clock = 0;
    const budgeted = new DuckDuckGoSearch({ transport: ok, maxQueries: 2, minIntervalMs: 3000, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
    assert.equal((await budgeted.search({ text: "a" })).length, 10);
    await budgeted.search({ text: "b", limit: 3 });
    assert.deepEqual(sleeps, [3000]);
    await assert.rejects(budgeted.search({ text: "c" }), (e: unknown) => e instanceof SearchUnavailableError && e.code === "budget");
    assert.equal(ok.gets.length, 2);

    // HTTP errors and transport failures are reported as such, not as results.
    await assert.rejects(new DuckDuckGoSearch({ transport: fakeTransport({ http: [{ status: 503, body: "<html><body>down</body></html>" }] }), minIntervalMs: 0 }).search({ text: "x" }), (e: unknown) => e instanceof SearchUnavailableError && e.code === "http-error");
    await assert.rejects(new DuckDuckGoSearch({ transport: fakeTransport({ http: [{ error: "ECONNRESET" }] }), minIntervalMs: 0 }).search({ text: "x" }), (e: unknown) => e instanceof SearchUnavailableError && e.code === "network");
});

test("search configuration comes from the environment with safe defaults and no keys", () => {
    assert.deepEqual(readSearchConfig({}), { provider: "duckduckgo", maxQueries: 6, minIntervalMs: 3000 });
    assert.deepEqual(readSearchConfig({ SEARCH_PROVIDER: "none", SEARCH_MAX_QUERIES: "2", SEARCH_MIN_INTERVAL_MS: "0" }), { provider: "none", maxQueries: 2, minIntervalMs: 0 });
    assert.throws(() => readSearchConfig({ SEARCH_PROVIDER: "google" }), /Unsupported SEARCH_PROVIDER/);
    assert.throws(() => readSearchConfig({ SEARCH_MAX_QUERIES: "-1" }), /SEARCH_MAX_QUERIES/);
});

test("sitemaps are discovered from robots.txt, narrowed to the wanted locale and searched by URL words", async () => {
    const transport = routedTransport({
        "https://support.riotgames.com/robots.txt": { body: "User-agent: *\nDisallow:\n\nSitemap: https://support.riotgames.com/sitemap_index.xml\n", headers: { "content-type": "text/plain" } },
        "https://support.riotgames.com/sitemap_index.xml": { body: fixture("riot-support-sitemap-index.xml"), headers: { "content-type": "application/xml" } },
        "https://support.riotgames.com/sitemaps/en-us/sitemap.xml": { body: fixture("riot-support-sitemap-en-us.xml"), headers: { "content-type": "application/xml" } }
    });
    const provider = new SitemapSearch({ hosts: ["support.riotgames.com"], transport });
    const results = await provider.search({ text: "League of Legends patch schedule", limit: 5 });
    assert.equal(results[0].url, LOL_SCHEDULE_URL);
    assert.equal(results[0].lastmod, "2019-02-26");
    assert.equal(results[0].provider, "sitemap");
    assert.ok(results.every(r => /\/en-us\//.test(r.url)), "only the wanted locale is offered");
    // Only the en-us child sitemap was fetched, and only once for the run.
    const fetched = transport.gets.map(g => g.url);
    assert.deepEqual(fetched, ["https://support.riotgames.com/robots.txt", "https://support.riotgames.com/sitemap_index.xml", "https://support.riotgames.com/sitemaps/en-us/sitemap.xml"]);
    await provider.search({ text: "League of Legends champion update schedule" });
    assert.equal(transport.gets.length, 3, "cached for the run");
    assert.deepEqual(provider.fetches.map(f => [f.outcome, f.entries]), [["usable", 24], ["usable", 60]]);

    // A site restriction outside the configured hosts yields nothing; a matching one works.
    assert.deepEqual(await provider.search({ text: "League of Legends patch schedule", site: "leagueoflegends.com" }), []);
    assert.equal((await provider.search({ text: "League of Legends patch schedule", site: "riotgames.com" }))[0].url, LOL_SCHEDULE_URL);

    // Malformed or missing sitemaps are reported, not parsed.
    const broken = new SitemapSearch({ hosts: ["broken.example"], transport: routedTransport({ "https://broken.example/sitemap.xml": { body: "<urlset><url><loc>https://broken.example/a", headers: { "content-type": "application/xml" } } }) });
    assert.deepEqual(await broken.search({ text: "anything here" }), []);
    assert.ok(broken.fetches.some(f => f.outcome === "unusable"));

    assert.deepEqual(sitemapUrlsFromRobots("Sitemap: /sitemap-a.xml\nsitemap: https://x.com/b.xml\nSitemap: https://x.com/b.xml", "https://x.com/"), ["https://x.com/sitemap-a.xml", "https://x.com/b.xml"]);
    assert.equal(parseSitemap("<html></html>"), undefined);
});

test("seed pages offer their own URL and their official links, scored by query words", async () => {
    const listing = fixture("lol-patch-notes-listing.html");
    const transport = routedTransport({ [LOL_NOTES_LISTING_URL]: { body: listing } });
    const provider = new SeedPageSearch({ seeds: [`${LOL_NOTES_LISTING_URL}/`], officialDomains: ["leagueoflegends.com", "riotgames.com"], transport, allowRender: false });
    const notes = await provider.search({ text: "League of Legends patch notes", limit: 20 });
    assert.ok(notes.some(r => r.url === LOL_NOTES_LISTING_URL), "the listing itself is a result");
    assert.ok(notes.some(r => r.url === "https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-18-notes"));
    assert.ok(notes.every(r => /leagueoflegends\.com|riotgames\.com/.test(r.url)), "only official links are offered");
    assert.equal(provider.fetches.length, 1);
    assert.equal(provider.fetches[0].outcome, "usable");

    const version = await provider.search({ text: "League of Legends patch 26.18" });
    assert.equal(version[0].url, "https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-18-notes");
    assert.equal(transport.gets.length, 1, "a seed is fetched once per run");

    // An unusable seed is logged and contributes nothing.
    const shell = new SeedPageSearch({ seeds: ["https://support.riotgames.com/en-us/league-of-legends/"], officialDomains: ["riotgames.com"], transport: routedTransport({ "https://support.riotgames.com/en-us/league-of-legends/": { body: fixture("riot-support-shell.html") } }), allowRender: false });
    assert.deepEqual(await shell.search({ text: "League of Legends patch schedule" }), []);
    assert.equal(shell.fetches[0].outcome, "unusable");
});

test("links are extracted absolute and canonical; official ones can be filtered", () => {
    const links = extractLinks(`<a href="/en-us/news/a?utm_source=x">A</a><a href="https://www.reddit.com/r/x">Reddit</a><a href="mailto:x@y.z">mail</a><a href="/en-us/news/a"><img alt=""></a><a href="#top">top</a>`, "https://www.leagueoflegends.com/en-us/news/");
    assert.deepEqual(links.map(l => [l.url, l.text]), [
        ["https://www.leagueoflegends.com/en-us/news/a", "A"],
        ["https://www.reddit.com/r/x", "Reddit"],
        ["https://www.leagueoflegends.com/en-us/news", "top"]
    ]);
    assert.deepEqual(officialLinks(links, ["leagueoflegends.com"]).map(l => l.url), ["https://www.leagueoflegends.com/en-us/news/a", "https://www.leagueoflegends.com/en-us/news"]);
});

test("content validation accepts redirects that stay within allowed domains", () => {
    const body = fixture("minecraft-article.html");
    const moved = validateContent({ requestedUrl: "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/1", finalUrl: LOL_SCHEDULE_URL, status: 200, body, expect: { kind: "html", allowDomains: ["riotgames.com"] } });
    assert.equal(moved.usable, true);
    const elsewhere = validateContent({ requestedUrl: "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/1", finalUrl: "https://evil.example/x", status: 200, body, expect: { kind: "html", allowDomains: ["riotgames.com"] } });
    assert.equal(elsewhere.code, "redirect");
});

test("every sitemap declared in robots.txt is read, not just the first non-empty one", async () => {
    const urlset = (locs: string[]) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map(l => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
    const xml = { "content-type": "application/xml" };
    const transport = routedTransport({
        "https://support.example.com/robots.txt": { body: "Sitemap: https://support.example.com/a.xml\nSitemap: https://support.example.com/b.xml\n", headers: { "content-type": "text/plain" } },
        "https://support.example.com/a.xml": { body: urlset(["https://support.example.com/en-us/billing/refunds"]), headers: xml },
        "https://support.example.com/b.xml": { body: urlset(["https://support.example.com/en-us/gameplay/patch-schedule"]), headers: xml }
    });
    const provider = new SitemapSearch({ hosts: ["support.example.com"], transport });
    assert.deepEqual((await provider.search({ text: "patch schedule" })).map(r => r.url), ["https://support.example.com/en-us/gameplay/patch-schedule"]);
    assert.deepEqual(provider.fetches.map(f => f.url), ["https://support.example.com/a.xml", "https://support.example.com/b.xml"]);
    assert.deepEqual((await provider.search({ text: "billing refunds" })).map(r => r.url), ["https://support.example.com/en-us/billing/refunds"], "both sitemaps stay cached for the run");
    assert.equal(transport.gets.length, 3);

    // Without declarations, the conventional locations are alternatives: the first non-empty one is enough.
    const fallback = routedTransport({
        "https://plain.example.com/sitemap.xml": { body: urlset(["https://plain.example.com/patch-schedule"]), headers: xml },
        "https://plain.example.com/sitemap_index.xml": { body: urlset(["https://plain.example.com/other"]), headers: xml }
    });
    const plain = new SitemapSearch({ hosts: ["plain.example.com"], transport: fallback });
    assert.equal((await plain.search({ text: "patch schedule" }))[0].url, "https://plain.example.com/patch-schedule");
    assert.ok(!fallback.gets.some(g => g.url.endsWith("sitemap_index.xml")));
});
