import test from "node:test";
import assert from "node:assert/strict";
import { validateContent } from "../fetch/content-validation";
import { fixture } from "./fake-transport";

function check(name: string, kind: "html" | "json" | "xml", url: string, status = 200, extra: Partial<Parameters<typeof validateContent>[0]["expect"]> = {}) {
    return validateContent({ requestedUrl: url, finalUrl: url, status, body: fixture(name), expect: { kind, ...extra } });
}

test("JavaScript application shells are detected and flagged for rendering", () => {
    const riot = check("riot-support-shell.html", "html", "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/360018987893-League-of-Legends-Patch-Schedule");
    assert.equal(riot.usable, false);
    assert.equal(riot.code, "js-shell");
    assert.equal(riot.renderMayHelp, true);
    assert.ok(riot.signals.bodyWordCount < 20);

    const genshin = check("genshin-news-shell.html", "html", "https://genshin.hoyoverse.com/en/news");
    assert.equal(genshin.code, "js-shell");
    assert.equal(genshin.renderMayHelp, true);
    assert.ok(genshin.signals.scriptCount >= 3);
});

test("bot-challenge pages are detected regardless of HTTP status", () => {
    const ea = check("ea-forums-challenge.html", "html", "https://forums.ea.com/category/ea-sports-fc-en/blog/ea-sports-fc-game-info-hub-en", 403);
    assert.equal(ea.code, "challenge");
    assert.equal(ea.renderMayHelp, true);
    assert.ok(ea.signals.challengeMarker);

    const fortniteHttp = check("fortnite-http-challenge.html", "html", "https://www.fortnite.com/battle-pass", 403);
    assert.equal(fortniteHttp.code, "challenge");

    // A challenge served with 200 after a browser navigation is still a challenge, not content.
    const fortniteRendered = check("fortnite-rendered-challenge.html", "html", "https://www.fortnite.com/battle-pass", 200);
    assert.equal(fortniteRendered.code, "challenge");
    assert.equal(fortniteRendered.usable, false);
});

test("real HTML pages are usable and carry extracted text", () => {
    for (const [name, url] of [
        ["minecraft-article.html", "https://feedback.minecraft.net/hc/en-us/articles/48149564061965-Minecraft-Bedrock-Edition-26-44-45-Hotfix-Changelog"],
        ["minecraft-changelog-listing.html", "https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs"],
        ["pubg-patch-notes-article.html", "https://pubg.com/en/news/9809"],
        ["valorant-game-updates.html", "https://playvalorant.com/en-us/news/game-updates/"]
    ]) {
        const verdict = check(name, "html", url);
        assert.equal(verdict.code, "usable", `${name}: ${verdict.reason}`);
        assert.equal(verdict.renderMayHelp, false);
        assert.ok(verdict.extracted && verdict.extracted.wordCount >= 120, name);
        assert.ok(verdict.extracted!.title.length > 0, name);
    }
});

test("expected markers and word thresholds are enforced", () => {
    const url = "https://feedback.minecraft.net/hc/en-us/articles/48149564061965-x";
    const withMarker = check("minecraft-article.html", "html", url, 200, { markers: ["Hotfix", "nonexistent"] });
    assert.equal(withMarker.code, "usable");
    assert.deepEqual(withMarker.signals.markersFound, ["Hotfix"]);

    const missingMarker = check("minecraft-article.html", "html", url, 200, { markers: ["Patch Schedule"] });
    assert.equal(missingMarker.code, "insufficient");
    assert.match(missingMarker.reason, /expected markers/);

    const tooShort = check("minecraft-article.html", "html", url, 200, { minWords: 5000 });
    assert.equal(tooShort.code, "js-shell"); // thin relative to the threshold and script-heavy
    assert.equal(tooShort.usable, false);
});

test("structured responses are validated by parsing, not by status", () => {
    assert.equal(check("roblox-hostedstatus.json", "json", "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d").code, "usable");
    assert.equal(check("zendesk-minecraft-articles.json", "json", "https://feedback.minecraft.net/api/v2/help_center/en-us/sections/360001186971/articles.json").code, "usable");
    assert.equal(check("mojang-version-manifest.json", "json", "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json").code, "usable");
    assert.equal(check("steam-cs2-news.rss.xml", "xml", "https://store.steampowered.com/feeds/news/app/730/?l=english").code, "usable");

    // Riot's "API" URL answers with the HTML shell: a 200 that is not JSON.
    const html = check("riot-support-shell.html", "json", "https://support-leagueoflegends.riotgames.com/api/v2/help_center/en-us/articles/360018987893.json");
    assert.equal(html.code, "parse-error");
    assert.equal(html.renderMayHelp, false);

    const notObject = validateContent({ requestedUrl: "https://x.example/a.json", finalUrl: "https://x.example/a.json", status: 200, body: "42", expect: { kind: "json" } });
    assert.equal(notObject.code, "parse-error");

    const notFeed = validateContent({ requestedUrl: "https://x.example/a.xml", finalUrl: "https://x.example/a.xml", status: 200, body: "<root><x/></root>", expect: { kind: "xml" } });
    assert.equal(notFeed.code, "parse-error");
});

test("unexpected redirects are rejected without rendering", () => {
    const body = fixture("minecraft-article.html");
    const run = (requested: string, final: string, allowHomepage = false) =>
        validateContent({ requestedUrl: requested, finalUrl: final, status: 200, body, expect: { kind: "html", allowHomepage } });

    assert.equal(run("https://a.example/news/123", "https://a.example/").code, "redirect");
    assert.equal(run("https://a.example/news/123", "https://a.example/").renderMayHelp, false);
    assert.equal(run("https://a.example/news/123", "https://b.example/news/123").code, "redirect");
    assert.equal(run("https://a.example/news/123", "https://a.example/login?next=/news/123").code, "redirect");
    assert.equal(run("https://a.example/news/123", "https://www.a.example/news/123").code, "usable");
    assert.equal(run("https://a.example/news/123", "https://a.example/", true).code, "usable");

    const allowed = validateContent({ requestedUrl: "https://a.example/news/123", finalUrl: "https://cdn.a.example/news/123", status: 200, body, expect: { kind: "html", allowHosts: ["a.example", "cdn.a.example"] } });
    assert.equal(allowed.code, "usable");
});

test("empty bodies, HTTP errors and enable-JavaScript shells", () => {
    const empty = validateContent({ requestedUrl: "https://a.example/x", finalUrl: "https://a.example/x", status: 200, body: "  ", expect: { kind: "html" } });
    assert.equal(empty.code, "empty");

    const serverError = validateContent({ requestedUrl: "https://a.example/x", finalUrl: "https://a.example/x", status: 503, body: "<html><body>Service unavailable</body></html>", expect: { kind: "html" } });
    assert.equal(serverError.code, "http-error");
    assert.equal(serverError.renderMayHelp, false);

    const forbidden = validateContent({ requestedUrl: "https://a.example/x", finalUrl: "https://a.example/x", status: 403, body: "<html><body>Forbidden</body></html>", expect: { kind: "html" } });
    assert.equal(forbidden.code, "http-error");
    assert.equal(forbidden.renderMayHelp, true);

    const enableJs = validateContent({
        requestedUrl: "https://a.example/app", finalUrl: "https://a.example/app", status: 200,
        body: "<html><head><script src='/a.js'></script></head><body><div id='root'></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>",
        expect: { kind: "html" }
    });
    assert.equal(enableJs.code, "enable-js");
    assert.equal(enableJs.renderMayHelp, true);

    const thinStatic = validateContent({ requestedUrl: "https://a.example/x", finalUrl: "https://a.example/x", status: 200, body: "<html><body><p>Coming soon.</p></body></html>", expect: { kind: "html" } });
    assert.equal(thinStatic.code, "insufficient");
    assert.equal(thinStatic.renderMayHelp, false);
});
