/**
 * What the pages say about where a value comes from must be what the code actually reads.
 *
 * The audit of 22 October 2026 found eight indexable pages making claims the registry disproved: PUBG
 * "read with browser-based extraction" from a patch page (it is the Steam news API), Minecraft "from the
 * feedback changelog" (it is the launcher's version manifest), GTA labelled "Verified from the official
 * source" for a value computed from a rule, a homepage promising "a live countdown" on every page. #73
 * guarded one kind of claim (cadence); none of these had a guard, and they had all drifted.
 *
 * So the claims are tied to the things that decide them:
 *   - copy lives in `gamePages`, and every authored page must equal what `applyCopy` writes from it;
 *   - each configured source host requires the About paragraph to name that kind of source;
 *   - a page declared computed in the manifest is exactly the page whose adapter computes;
 *   - phrases that promise behaviour the site does not have are refused outright.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { gtaWeeklyResetAdapter } from "../adapters/gta";
import { GAMES, adapterFor, findTopic } from "../games";
import { blocksFor, renderTrackerHtml } from "../../render-pages";
import { trackerPages } from "../../site-map";
import { applyCopy } from "../../update-copy";
import { gamePages } from "../../update-game-pages";

const PUBLIC = path.join(__dirname, "..", "..", "..", "public");
const read = (page: string) => fs.readFileSync(path.join(PUBLIC, page), "utf8");

/** Each host a tracker reads, and what its About paragraph must say to name that source truthfully. */
const SOURCE_CLAIMS: Record<string, RegExp> = {
    "api.steampowered.com": /Steam news feed|on Steam/,
    "piston-meta.mojang.com": /version manifest/,
    "support-leagueoflegends.riotgames.com": /patch schedule/,
    "playvalorant.com": /playvalorant\.com/,
    "www.callofduty.com": /callofduty\.com|Call of Duty patch notes/,
    "sg-hk4e-api.hoyoverse.com": /in-game announcements/,
    "hostedstatus.com": /status\.roblox\.com/,
    "www.rockstargames.com": /rule/
};

/** Promises the site does not keep, or sources it does not read. */
const FORBIDDEN: Array<[RegExp, string]> = [
    [/live countdown/i, "most pages show a past date; only exact future times count down, and only with JavaScript"],
    [/real[- ]time/i, "sources are read several times a day"],
    [/live (status|monitoring|tracking)/i, "sources are read several times a day"],
    [/browser-based extraction/i, "no tracker page is read that way"],
    [/feedback changelog/i, "Minecraft is read from the launcher's version manifest"],
    [/\bRSS\b/, "no source is an RSS feed"],
    [/HoYoLAB/i, "Genshin is read from the in-game announcement feed"],
    [/Data Unavailable/, "the site says \"No official date announced\" or \"Data unavailable\", and promises neither by name"],
    [/zero maintenance|no manual (intervention|updates)/i, "the site is maintained through reviewed changes"],
    [/highest-confidence/i, "a computed rule is not more verified than a read source"]
];

/** The visible text of a page, without the noscript note (which accurately describes the JavaScript). */
function visibleText(html: string): string {
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    return [$("title").text(), $('meta[name="description"]').attr("content") ?? "", $("body").text()].join(" ").replace(/\s+/g, " ");
}

test("every tracker page carries exactly the copy gamePages holds for it", () => {
    for (const page of gamePages) {
        const html = read(page.path);
        assert.equal(applyCopy(html, page), html, `${page.path} has drifted from gamePages; run npm run copy:apply`);
    }
});

test("the copy tool owns the fields it claims, and nothing else", () => {
    const page = gamePages.find(p => p.game === "pubg")!;
    const html = read(page.path);
    const edited = applyCopy(html, { ...page, aboutTracker: "A test sentence & <one> more.", faq: [{ q: "Q?", a: "A \"quoted\" answer." }] });
    assert.match(edited, /<p>A test sentence &amp; &lt;one&gt; more\.<\/p>/);
    assert.match(edited, /"text": "A \\"quoted\\" answer\."/);
    assert.match(edited, /<summary>Q\?<\/summary>/);
    // Outside its fields the page is untouched.
    const strip = (h: string) => h.replace(/<!-- About -->[\s\S]*?<!-- What Is It -->/, "").replace(/<!-- FAQ -->[\s\S]*?<\/div>/, "").replace(/<script type="application\/ld\+json">[\s\S]*?FAQPage[\s\S]*?<\/script>/, "");
    assert.equal(strip(edited), strip(html));
    const dropped = applyCopy(html, { ...page, whatChanges: [] });
    assert.doesNotMatch(dropped, /<!-- What Changes -->/, "an empty list removes the section rather than leaving it empty");
    assert.doesNotMatch(dropped.replace(/\r\n/g, "\n"), /<\/div>\n\n\n/, "and leaves no double blank line behind");
    // Codex, #76: removing a section also removed the only marker that found it, so a list could never come
    // back. Restoring the list must recreate the section, byte for byte where it was.
    assert.equal(applyCopy(dropped, page), html, "removing and restoring a list is a round trip");
    assert.equal(applyCopy(applyCopy(dropped, page), page), html, "and stays idempotent");
});

test("each tracker names the kind of source the registry actually reads", () => {
    for (const game of GAMES) {
        for (const topic of game.topics) {
            const page = gamePages.find(p => p.game === topic.game && p.type === topic.type);
            assert.ok(page, `${topic.game}/${topic.type} has no gamePages entry`);
            const hosts = new Set(game.sources.map(s => new URL(s.url).hostname));
            assert.ok(hosts.size > 0, `${topic.game} has no configured source`);
            for (const host of hosts) {
                const claim = SOURCE_CLAIMS[host];
                assert.ok(claim, `${topic.game} reads ${host}, which no source claim describes: add one to SOURCE_CLAIMS and say so on the page`);
                assert.match(page.aboutTracker, claim, `${page.path}: the About paragraph does not name ${host}`);
            }
        }
    }
});

test("no page promises behaviour the site does not have", () => {
    const pages = [...trackerPages().map(p => p.page), "index.html", "about/index.html"];
    for (const page of pages) {
        const text = visibleText(read(page));
        for (const [pattern, why] of FORBIDDEN) {
            const found = pattern.exec(text);
            assert.equal(found, null, `${page} says "${found?.[0]}": ${why}`);
        }
    }
    for (const page of gamePages) {
        for (const field of [page.metaDescription, page.aboutTracker, page.whatIsIt, ...page.faq.flatMap(f => [f.q, f.a])]) {
            for (const [pattern, why] of FORBIDDEN) assert.doesNotMatch(field, pattern, `${page.path}: ${why}`);
        }
    }
});

test("the homepage lists every tracker with the summary gamePages holds for it", () => {
    const $ = cheerio.load(read("index.html"));
    const items = $("ul.games-list li").map((_, li) => ({ href: $(li).find("a").attr("href"), text: $(li).text().replace(/\s+/g, " ").trim() })).get();
    assert.equal(items.length, gamePages.length);
    for (const page of gamePages) {
        const href = `/${page.path.replace(/index\.html$/, "")}`;
        const item = items.find(i => i.href === href);
        assert.ok(item, `${href} is missing from the homepage list`);
        assert.equal(item!.text, `${page.title} — ${page.listSummary}`);
    }
});

test("a page is declared computed exactly when its adapter computes rather than reads", () => {
    for (const entry of trackerPages()) {
        const game = GAMES.find(g => g.id === entry.tracker!.game);
        if (!game) continue; // V1 trackers read pages; none is computed.
        const computes = adapterFor(findTopic(game, entry.tracker!.type)) === gtaWeeklyResetAdapter;
        assert.equal(Boolean(entry.tracker!.computedFrom), computes, `${entry.page}: manifest and adapter disagree about whether the value is computed`);
    }
});

test("a computed value is labelled as computed, never as verified", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    const data = {
        provider_id: "gta", game: "gta", type: "weekly-reset", title: "GTA Online Weekly Reset", status: "fresh",
        nextEventUtc: "2026-10-29T10:00:00.000Z", fetched_at_utc: now.toISOString(), last_success_at_utc: now.toISOString(),
        source_url: "https://www.rockstargames.com/gta-online", confidence: "high", precision: "exact"
    };
    const html = renderTrackerHtml(read("gta/weekly-reset/index.html"), data as any, "gta", now);
    const $ = cheerio.load(html);
    assert.match($("#tracker-status").text(), /^Computed from a weekly rule, every Thursday at 10:00 UTC, not read from a page$/);
    assert.doesNotMatch($(".info-row").text(), /Verified/);
    assert.equal($(".countdown-label").first().text(), "Computed date and time", "the headline does not call a computed value official");
    assert.match($(".info-row").text(), /Last Computed/);
    assert.equal($("#source").attr("data-basis"), "rule", "app.js leaves a rule's source text alone");
    assert.equal($("#source a").length, 0, "there is no source to link to");

    // A read value keeps its verification labels.
    const cs2 = renderTrackerHtml(read("cs2/last-update/index.html"), { ...data, provider_id: "cs2", game: "cs2", type: "last-update", source_url: "https://store.steampowered.com/news/app/730" } as any, "cs2", now);
    assert.match(cheerio.load(cs2)("#tracker-status").text(), /Verified from the official source/);
    assert.match(cheerio.load(cs2)(".info-row").text(), /Last Verified/);
});

test("a status tracker's instant is labelled as when the status changed, not as an announced date", () => {
    const b = blocksFor({ game: "roblox", type: "status", status: "fresh", nextEventUtc: "2026-10-05T23:13:06.502Z", confidence: "high", precision: "exact", notes: "Current status: Operational" } as any, new Date("2026-10-22T12:00:00Z"));
    assert.equal(b.label, "Status last changed");
    const lol = blocksFor({ game: "lol", type: "next-patch", status: "fresh", nextEventUtc: "2026-11-04T00:00:00.000Z", confidence: "high", precision: "day" } as any, new Date("2026-10-22T12:00:00Z"));
    assert.equal(lol.label, "Official date");
});

test("while any tracker is computed, no site-wide sentence calls every value verified or read from a publisher", () => {
    // Codex, #76/#77: "Each has a page with the latest verified value" and "every date comes from the
    // publisher" were true of eleven trackers and false of GTA Online's computed weekly reset.
    const computed = trackerPages().some(entry => entry.tracker!.computedFrom);
    assert.ok(computed, "this test only means something while a computed tracker exists");
    for (const page of ["index.html", "about/index.html"]) {
        const sentences = visibleText(read(page)).split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
            const blanket = /\b(each|every)\b[^.]*\b(verified value|value[^.]*official source|date[^.]*from the publisher|answer is[^.]*from the publisher)/i.test(sentence);
            if (!blanket) continue;
            assert.match(sentence, /rule|computed/i, `${page}: "${sentence.slice(0, 140)}" claims every value is read, with no word for the computed one`);
        }
    }
});
