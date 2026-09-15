import test from "node:test";
import assert from "node:assert/strict";
import { MockAiProvider } from "../ai/mock";
import { AiJsonRequest } from "../ai/provider";
import { createSearchProviders, discoverSources, shouldDiscover } from "../discovery/discovery";
import { applyRelevance, needsAiRelevance, parseRelevance } from "../discovery/relevance";
import { MockSearchProvider, SearchResult } from "../discovery/search-provider";
import { emptyKnowledge } from "../domain";
import { upsertEvent } from "../knowledge";
import { LOL_NOTES_LISTING_URL, LOL_SCHEDULE_URL, lolGame } from "./discovery-fixtures";
import { fixture } from "./fake-transport";
import { routedTransport } from "./routed-transport";

const now = new Date("2026-09-15T06:00:00Z");
const r = (url: string, title: string, snippet?: string): SearchResult => ({ url, title, snippet, rank: 0, provider: "" });

const OFFICIAL_HIT = r(LOL_SCHEDULE_URL, "Patch Schedule - League of Legends Support", "League of Legends periodically releases patches");
const SECONDARY_HIT = r("https://www.reddit.com/r/leagueoflegends/comments/abc/league_of_legends_patch_schedule/", "League of Legends patch schedule? : r/leagueoflegends", "Does anyone know when 26.19 drops?");

test("official channels that answer convincingly mean no web search at all", async () => {
    const game = lolGame();
    const sitemap = new MockSearchProvider("sitemap", "official", { "League of Legends patch schedule": [r(LOL_SCHEDULE_URL, "", "sitemap"), r("https://support.riotgames.com/en-us/league-of-legends/gameplay/champion-update-schedule", "")] });
    const web = new MockSearchProvider("duckduckgo", "web", { "site:riotgames.com League of Legends patch schedule": [OFFICIAL_HIT] });
    const result = await discoverSources({ game, topic: game.topics[0], knowledge: emptyKnowledge("lol", now), now, officialProviders: [sitemap], webProvider: web });

    assert.equal(result.searchedWeb, false);
    assert.equal(web.queries.length, 0, "the web provider was never asked");
    assert.equal(result.official[0].url, LOL_SCHEDULE_URL);
    assert.equal(result.official[0].via, "sitemap");
    assert.ok(result.official[0].score >= 6, `score ${result.official[0].score}: ${result.official[0].reasons.join("; ")}`);
    assert.deepEqual(result.queries.map(q => q.provider), ["sitemap", "sitemap"], "one query per template, no {next} without a known version");
    assert.deepEqual(result.unavailable, []);
});

test("web search runs site-restricted queries first and never makes a secondary page publishable", async () => {
    const game = lolGame();
    const sitemap = new MockSearchProvider("sitemap", "official", {});
    const web = new MockSearchProvider("duckduckgo", "web", {
        "site:riotgames.com League of Legends patch schedule": [OFFICIAL_HIT, r(`${LOL_SCHEDULE_URL}/?utm_source=ddg`, "dup")],
        "League of Legends patch schedule": [SECONDARY_HIT, OFFICIAL_HIT]
    });
    const result = await discoverSources({ game, topic: game.topics[0], knowledge: emptyKnowledge("lol", now), now, officialProviders: [sitemap], webProvider: web });

    assert.equal(result.searchedWeb, true);
    assert.deepEqual(web.queries.map(q => `${q.site ?? ""}|${q.text}`), ["riotgames.com|League of Legends patch schedule"], "stopped as soon as an official page convinced");
    assert.equal(result.candidates.filter(c => c.url === LOL_SCHEDULE_URL).length, 1, "duplicates merged");
    assert.equal(result.official[0].url, LOL_SCHEDULE_URL);
    assert.equal(result.official[0].via, "web");

    // With a known latest version, the {next} query exists and secondary results are carried but flagged.
    const k = emptyKnowledge("lol", now);
    upsertEvent(k, game.topics[0], { identity: "26.18", label: "26.18", status: "ended", at: "2026-09-09T18:00:00.000Z", precision: "exact" }, now, "test");
    const open = new MockSearchProvider("duckduckgo", "web", { "League of Legends patch schedule": [SECONDARY_HIT] });
    const second = await discoverSources({ game, topic: game.topics[0], knowledge: k, now, officialProviders: [sitemap], webProvider: open, limits: { maxWebQueries: 10 } });
    assert.ok(open.queries.some(q => q.text === "League of Legends patch 26.19"), "the next version is asked for");
    assert.equal(second.official.length, 0);
    const reddit = second.candidates.find(c => c.tier === "secondary")!;
    assert.equal(reddit.publishable, false);
    assert.ok(!reddit.reasons.some(x => /official domain/.test(x)));
});

test("a secondary result can lead to the official page, which is then the only publishable candidate", async () => {
    const game = lolGame();
    const sitemap = new MockSearchProvider("sitemap", "official", {});
    const web = new MockSearchProvider("duckduckgo", "web", { "League of Legends patch schedule": [SECONDARY_HIT] });
    const redditHtml = `<html><head><title>League of Legends patch schedule? : r/leagueoflegends</title></head><body><main><p>${"Does anyone know when the next patch drops? ".repeat(6)}Riot posts the full list here: <a href="${LOL_SCHEDULE_URL}/">Patch Schedule - League of Legends Support</a>. Also see <a href="https://www.youtube.com/watch?v=x">this video</a> and <a href="https://evil-riotgames.com/schedule">this mirror</a>.</p></main></body></html>`;
    const transport = routedTransport({ "https://www.reddit.com/r/leagueoflegends/comments/abc/league_of_legends_patch_schedule": { body: redditHtml } });
    const result = await discoverSources({ game, topic: game.topics[0], knowledge: emptyKnowledge("lol", now), now, officialProviders: [sitemap], webProvider: web, transport, limits: { maxWebQueries: 10 } });

    assert.deepEqual(result.official.map(c => c.url), [LOL_SCHEDULE_URL]);
    assert.equal(result.official[0].via, "secondary-link");
    assert.ok(result.official[0].reasons.some(x => /linked from https:\/\/www\.reddit\.com/.test(x)));
    assert.equal(result.candidates[0].url, LOL_SCHEDULE_URL, "the official page outranks the page that led to it");
    assert.ok(result.candidates.some(c => c.tier === "secondary" && !c.publishable));
    assert.ok(!result.candidates.some(c => /evil-riotgames|youtube/.test(c.url)), "look-alike and unrelated links are not candidates");
    assert.equal(transport.gets.length, 1, "one hop");
});

test("a challenged web provider is a clean failure and is not asked again", async () => {
    const game = lolGame();
    const seed = new MockSearchProvider("seed", "official", { "League of Legends patch notes": [r(LOL_NOTES_LISTING_URL, "Patch Notes")] });
    const web = new MockSearchProvider("duckduckgo", "web", { "site:riotgames.com League of Legends patch schedule": "challenge", "site:leagueoflegends.com League of Legends patch schedule": [OFFICIAL_HIT] });
    const result = await discoverSources({ game, topic: game.topics[0], knowledge: emptyKnowledge("lol", now), now, officialProviders: [seed], webProvider: web, limits: { maxWebQueries: 10, minOfficialScore: 20 } });

    assert.deepEqual(result.unavailable, ["duckduckgo"]);
    assert.equal(web.queries.length, 1, "no query after the challenge");
    assert.equal(result.official[0].url, LOL_NOTES_LISTING_URL, "what the official channel found is still returned");
    assert.ok(result.queries.some(q => q.provider === "duckduckgo" && /challenge/.test(q.error ?? "")));
});

test("discovery is skipped when known sources already answer the question", () => {
    const game = lolGame();
    const topic = game.topics[0];
    const k = emptyKnowledge("lol", now);
    assert.equal(shouldDiscover({ topic, knowledge: k, now, knownSources: 0, usableKnownSources: 0 }).discover, true);
    assert.equal(shouldDiscover({ topic, knowledge: k, now, knownSources: 1, usableKnownSources: 0 }).discover, true);
    assert.match(shouldDiscover({ topic, knowledge: k, now, knownSources: 1, usableKnownSources: 1 }).reason, /no future scheduled event/);

    upsertEvent(k, topic, { identity: "26.19", label: "26.19", status: "scheduled", at: "2026-09-23T00:00:00.000Z", precision: "day" }, now, "test");
    const answered = shouldDiscover({ topic, knowledge: k, now, knownSources: 1, usableKnownSources: 1 });
    assert.equal(answered.discover, false);
    assert.match(answered.reason, /next event already known: 26\.19/);
    assert.equal(shouldDiscover({ topic, knowledge: k, now: new Date("2026-09-24T00:00:00Z"), knownSources: 1, usableKnownSources: 1 }).discover, true, "once it passed, the question is open again");

    const usable = { ...topic, discovery: { ...topic.discovery, answeredWhen: "usable-source" as const } };
    assert.equal(shouldDiscover({ topic: usable, knowledge: emptyKnowledge("lol", now), now, knownSources: 1, usableKnownSources: 1 }).discover, false);
});

test("AI relevance only breaks ties, cannot promote a secondary page, and failure keeps the deterministic order", async () => {
    const game = lolGame();
    // Two official pages that score identically on words alone.
    const HISTORY_URL = "https://support.riotgames.com/en-us/league-of-legends/gameplay/league-of-legends-patch-schedule-history";
    const sitemap = new MockSearchProvider("sitemap", "official", { "League of Legends patch schedule": [r(LOL_SCHEDULE_URL, ""), r(HISTORY_URL, "")] });
    const ai = new MockAiProvider("mock-model", async (req: AiJsonRequest) => {
        assert.match(req.prompt, /Candidates:/);
        assert.ok(!/reddit/.test(req.prompt), "only official candidates are shown to the model");
        return { candidates: [
            { url: LOL_SCHEDULE_URL, relevant: true, reason: "the current schedule" },
            { url: HISTORY_URL, relevant: false, reason: "past schedules" },
            { url: "https://www.reddit.com/r/x", relevant: true, reason: "made up" }
        ] };
    });
    const result = await discoverSources({ game, topic: game.topics[0], knowledge: emptyKnowledge("lol", now), now, officialProviders: [sitemap], ai });
    assert.equal(result.ai?.used, true);
    assert.equal(result.ai?.verdicts, 2, "an invented URL is ignored");
    assert.equal(result.official[0].url, LOL_SCHEDULE_URL);
    assert.ok(result.official[0].reasons.some(x => /ai: relevant/.test(x)));
    assert.ok(result.official[1].reasons.some(x => /ai: not relevant/.test(x)));

    const failing = new MockAiProvider("mock-model", async () => { throw new Error("quota"); });
    const fallback = await discoverSources({ game, topic: game.topics[0], knowledge: emptyKnowledge("lol", now), now, officialProviders: [sitemap], ai: failing });
    assert.equal(fallback.ai?.used, false);
    assert.match(fallback.ai?.error ?? "", /quota/);
    assert.equal(fallback.official[0].score, fallback.official[1].score, "a genuine tie");
    assert.equal(fallback.official[0].url, HISTORY_URL, "deterministic order (URL tie-break) stands");

    // No AI call when the ranking is already clear.
    const clear = new MockSearchProvider("sitemap", "official", { "League of Legends patch schedule": [r(LOL_SCHEDULE_URL, "Patch Schedule")] });
    const untouched = await discoverSources({ game, topic: game.topics[0], knowledge: emptyKnowledge("lol", now), now, officialProviders: [clear], ai: failing });
    assert.equal(untouched.ai, undefined);

    const secondary = { url: "https://www.reddit.com/r/x", tier: "secondary" as const, via: "web" as const, provider: "duckduckgo", score: 1, reasons: [], publishable: false };
    const nudged = applyRelevance([secondary], [{ url: secondary.url, relevant: true, reason: "" }]);
    assert.equal(nudged[0].tier, "secondary");
    assert.equal(nudged[0].publishable, false);
    assert.equal(needsAiRelevance([{ ...secondary, tier: "official", score: 8 }, { ...secondary, tier: "official", score: 4 }]), false);
    assert.throws(() => parseRelevance({ nope: 1 }, []), /no candidates array/);
});

test("providers are built from the game's discovery configuration and the search config", () => {
    const game = lolGame();
    const withWeb = createSearchProviders(game, { provider: "duckduckgo", maxQueries: 2, minIntervalMs: 0 });
    assert.deepEqual(withWeb.official.map(p => p.name), ["sitemap", "seed"]);
    assert.equal(withWeb.web?.name, "duckduckgo");
    const none = createSearchProviders(lolGame({ discovery: { officialDomains: ["riotgames.com"] } }), { provider: "none", maxQueries: 0, minIntervalMs: 0 });
    assert.deepEqual(none.official, []);
    assert.equal(none.web, undefined);
    assert.equal(fixture("riot-support-shell.html").length > 0, true);
});
