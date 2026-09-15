import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, contentUrlProblem, dedupeKey, isEnglishLocale, isOfficialUrl, localeAgnosticKey, localeOf, normalizeDomain, officialDomainOf, slugTokens } from "../discovery/urls";

test("canonicalUrl removes what does not identify a page", () => {
    assert.equal(canonicalUrl("HTTPS://Support.RiotGames.com:443/en-us/x/?utm_source=a&b=2&a=1#frag"), "https://support.riotgames.com/en-us/x?a=1&b=2");
    assert.equal(canonicalUrl("https://example.com//a//b/"), "https://example.com/a/b");
    assert.equal(canonicalUrl("https://example.com/"), "https://example.com/");
    assert.equal(canonicalUrl("/en-us/news/x", "https://www.leagueoflegends.com/en-us/news/tags/patch-notes/"), "https://www.leagueoflegends.com/en-us/news/x");
    assert.equal(canonicalUrl("mailto:a@b.c"), undefined);
    assert.equal(canonicalUrl("javascript:void(0)"), undefined);
    assert.equal(canonicalUrl("not a url"), undefined);
    assert.equal(canonicalUrl("https://x.com/p?fbclid=1&gclid=2&ref=3"), "https://x.com/p");
});

test("dedupeKey ignores scheme and www", () => {
    assert.equal(dedupeKey("http://www.example.com/a?x=1"), dedupeKey("https://example.com/a?x=1"));
    assert.notEqual(dedupeKey("https://example.com/a"), dedupeKey("https://example.com/b"));
});

test("locales are recognised in the first two path segments or a lang parameter", () => {
    assert.equal(localeOf("https://support.riotgames.com/en-us/league-of-legends/x"), "en-us");
    assert.equal(localeOf("https://support.riotgames.com/de-de/league-of-legends/x"), "de-de");
    assert.equal(localeOf("https://feedback.minecraft.net/hc/en-us/articles/1"), "en-us");
    assert.equal(localeOf("https://x.com/hc/articles/1"), undefined, "hc is not a language");
    assert.equal(localeOf("https://x.com/de/news"), "de");
    assert.equal(localeOf("https://x.com/news?lang=ja"), "ja");
    assert.equal(localeOf("https://x.com/pc/news"), undefined, "pc is not a language");
    assert.equal(isEnglishLocale(undefined), true);
    assert.equal(isEnglishLocale("en-gb"), true);
    assert.equal(isEnglishLocale("pt-br"), false);
    assert.equal(localeAgnosticKey("https://support.riotgames.com/de-de/league-of-legends/x"), localeAgnosticKey("https://support.riotgames.com/en-us/league-of-legends/x"));
    assert.equal(localeAgnosticKey("https://x.com/news?lang=ja&p=1"), localeAgnosticKey("https://x.com/news?p=1"));
});

test("official domains match the host or a subdomain, never a look-alike", () => {
    const domains = ["riotgames.com", "www.leagueoflegends.com"];
    assert.equal(isOfficialUrl("https://support.riotgames.com/x", domains), true);
    assert.equal(isOfficialUrl("https://riotgames.com/x", domains), true);
    assert.equal(isOfficialUrl("https://www.leagueoflegends.com/en-us/news", domains), true);
    assert.equal(isOfficialUrl("https://leagueoflegends.com/en-us/news", domains), true);
    assert.equal(isOfficialUrl("https://evil-riotgames.com/x", domains), false);
    assert.equal(isOfficialUrl("https://riotgames.com.evil.net/x", domains), false);
    assert.equal(isOfficialUrl("https://www.reddit.com/r/leagueoflegends", domains), false);
    assert.equal(officialDomainOf("https://support.riotgames.com/x", domains), "riotgames.com");
    assert.equal(normalizeDomain("https://WWW.Example.com/path"), "example.com");
});

test("slug tokens and non-content URLs", () => {
    assert.deepEqual(slugTokens("https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends"), ["en", "us", "league", "of", "legends", "gameplay", "patch", "schedule", "league", "of", "legends"]);
    assert.equal(contentUrlProblem("https://x.com/a.pdf"), "not an HTML page");
    assert.equal(contentUrlProblem("https://x.com/login"), "account or search page");
    assert.equal(contentUrlProblem("https://x.com/search?q=patch"), "account or search page");
    assert.equal(contentUrlProblem("https://x.com/news/patch-26-19"), undefined);
});
