import test from "node:test";
import assert from "node:assert/strict";
import { Candidate, candidateFrom, normalizeCandidates, publishableCandidates, rankCandidates, scoreCandidate } from "../discovery/candidates";
import { SearchResult } from "../discovery/search-provider";
import { LOL_SCHEDULE_URL } from "./discovery-fixtures";

const DOMAINS = ["riotgames.com", "leagueoflegends.com"];

function result(url: string, title = "", snippet?: string): SearchResult {
    return { url, title, snippet, rank: 1, provider: "test" };
}

function candidate(url: string, extra: Partial<Candidate> = {}): Candidate {
    return { ...candidateFrom(result(url, extra.title ?? ""), extra.via ?? "web", extra.query, DOMAINS)!, ...extra };
}

test("tier follows the host: official domains are publishable, everything else is not", () => {
    const official = candidateFrom(result(LOL_SCHEDULE_URL, "Patch Schedule"), "web", "q", DOMAINS)!;
    assert.equal(official.tier, "official");
    assert.equal(official.publishable, true);
    const reddit = candidateFrom(result("https://www.reddit.com/r/leagueoflegends/comments/x", "When is the next patch?"), "web", "q", DOMAINS)!;
    assert.equal(reddit.tier, "secondary");
    assert.equal(reddit.publishable, false);
    assert.equal(candidateFrom(result("ftp://x"), "web", "q", DOMAINS), undefined);
});

test("duplicate spellings and locale variants collapse to one English candidate", () => {
    const { kept, rejected } = normalizeCandidates([
        candidate(`${LOL_SCHEDULE_URL}/?utm_source=ddg#top`, { via: "web" }),
        candidate(`http://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends`, { via: "sitemap", title: "Patch Schedule" }),
        candidate("https://support.riotgames.com/de-de/league-of-legends/gameplay/patch-schedule-league-of-legends", { via: "web" }),
        candidate("https://support.riotgames.com/ja-jp/league-of-legends/gameplay/patch-schedule-league-of-legends", { via: "web" }),
        candidate("https://support.riotgames.com/fr-fr/league-of-legends/gameplay/champion-update-schedule", { via: "web" }),
        candidate("https://support.riotgames.com/en-us/league-of-legends/gameplay/notes.pdf", { via: "web" }),
        candidate("https://support.riotgames.com/en-us/login", { via: "web" })
    ]);
    assert.deepEqual(kept.map(c => c.url), [LOL_SCHEDULE_URL]);
    assert.equal(kept[0].via, "sitemap", "the more trusted channel wins the merge");
    assert.equal(kept[0].title, "Patch Schedule");
    assert.equal(kept[0].locale, "en-us");
    const reasons = rejected.map(r => r.reason);
    assert.ok(reasons.some(r => /locale variant of/.test(r)));
    assert.ok(reasons.some(r => /non-English locale fr-fr/.test(r)), "a page only known in another language is not used");
    assert.ok(reasons.includes("not an HTML page"));
    assert.ok(reasons.includes("account or search page"));
});

test("scoring prefers official pages that match the query and the topic's preferred terms", () => {
    const ctx = { terms: ["league", "legends", "patch", "schedule"], preferred: ["patch schedule"] };
    const schedule = scoreCandidate(candidate(LOL_SCHEDULE_URL, { via: "sitemap", title: "Patch Schedule - League of Legends Support", query: "League of Legends patch schedule" }), ctx);
    const champion = scoreCandidate(candidate("https://support.riotgames.com/en-us/league-of-legends/gameplay/champion-update-schedule", { via: "sitemap", title: "Champion Update Schedule", query: "League of Legends patch schedule" }), ctx);
    const reddit = scoreCandidate(candidate("https://www.reddit.com/r/leagueoflegends/comments/x/league_of_legends_patch_schedule", { via: "web", title: "League of Legends patch schedule?", query: "League of Legends patch schedule" }), ctx);
    assert.ok(schedule.score > champion.score, `${schedule.score} > ${champion.score}`);
    assert.ok(schedule.score > reddit.score);
    assert.ok(schedule.reasons.some(r => /official domain/.test(r)));
    assert.ok(schedule.reasons.some(r => /preferred "patch schedule"/.test(r)));
    assert.ok(!reddit.reasons.some(r => /official domain/.test(r)));

    const ranked = rankCandidates([reddit, champion, schedule]);
    assert.deepEqual(ranked.map(c => c.url), [schedule.url, champion.url, reddit.url]);
    assert.deepEqual(rankCandidates([schedule, champion, reddit]).map(c => c.url), ranked.map(c => c.url), "ranking is order-independent");
    assert.deepEqual(publishableCandidates(ranked).map(c => c.url), [schedule.url, champion.url]);
});
