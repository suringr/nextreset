/**
 * Obviously obsolete candidates are rejected deterministically, before any model call.
 *
 * When the verified patch is 26.19, a page about 26.10 cannot say when the next patch arrives.
 * The rule is opt-in per topic and only applies while the topic's question is about a future
 * version, so topics that need historical evidence keep every candidate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AiProvider } from "../ai/provider";
import { createAiDiscoveryAdapter } from "../adapters/ai-discovery";
import { discoverSources } from "../discovery/discovery";
import { discoveredSourceId } from "../discovery/learning";
import { candidateVersion, compareVersions, labelVersion, latestKnownVersion, obsoleteReason, rejectsOlderVersions } from "../discovery/obsolete";
import { SearchProvider, SearchQuery, SearchResult, SearchScope } from "../discovery/search-provider";
import { Event, GameKnowledge, Topic, emptyKnowledge } from "../domain";
import { LOL_NEXT_PATCH_SPEC, LOL_PATCH_SCHEDULE_URL, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { tempStore } from "./helpers";
import { routedTransport } from "./routed-transport";

const NOW = new Date("2026-09-16T06:00:00Z");
const SCHEDULE = "https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends";
const NOTES = (version: string) => `https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-${version}-notes`;

function patch(version: string, at: string, status: Event["status"] = "ended"): Event {
    return {
        key: `lol/next-patch/${version}`, game: "lol", topic: "next-patch", kind: "version",
        label: version, status, at, precision: "day", timezone: "UTC",
        firstSeen: "2026-01-01T00:00:00.000Z", lastVerified: NOW.toISOString(), publishState: "published"
    };
}

function lolKnowledge(): GameKnowledge {
    const knowledge = emptyKnowledge("lol", NOW);
    knowledge.events.push(patch("26.18", "2026-09-09T00:00:00.000Z"));
    knowledge.events.push(patch("26.19", "2026-09-23T00:00:00.000Z", "scheduled"));
    return knowledge;
}

/** A search provider that answers every query with the same results. */
class FixedSearch implements SearchProvider {
    readonly queries: SearchQuery[] = [];
    constructor(readonly name: string, readonly scope: SearchScope, private readonly results: Array<{ url: string; title: string }>) { }
    async search(query: SearchQuery): Promise<SearchResult[]> {
        this.queries.push(query);
        return this.results.map((r, i) => ({ ...r, rank: i + 1, provider: this.name }));
    }
}

/** Counts every model call, so "no model call" is asserted rather than assumed. */
function countingAi(): AiProvider & { calls: number } {
    const provider = {
        name: "gemini",
        model: "gemini-3.5-flash",
        calls: 0,
        generateJson: async () => {
            provider.calls++;
            throw new Error("an obsolete candidate must never reach the model");
        }
    };
    return provider;
}

test("a version is only read from text that names it", () => {
    assert.deepEqual(candidateVersion(NOTES("26-10")), [26, 10], "the URL slug names the patch");
    assert.deepEqual(candidateVersion("https://example.com/news/item", "Patch 26.11 Notes"), [26, 11]);
    assert.deepEqual(candidateVersion("https://www.ea.com/news", "EA SPORTS FC 26 version 1.6.5"), [1, 6, 5]);
    assert.equal(candidateVersion(SCHEDULE), undefined, "a schedule page names no single version");
    assert.equal(candidateVersion("https://example.com/news/2026-09-23-something"), undefined, "a date is not a version");
    assert.equal(candidateVersion("https://example.com/articles/12-34"), undefined, "a bare number pair is not a version");
});

test("versions order numerically, segment by segment", () => {
    assert.ok(compareVersions([26, 10], [26, 9]) > 0, "26.10 is newer than 26.9");
    assert.ok(compareVersions([26, 10], [26, 19]) < 0);
    assert.equal(compareVersions([26, 19], [26, 19]), 0);
    assert.ok(compareVersions([26, 19, 1], [26, 19]) > 0);
    assert.deepEqual(labelVersion("26.19"), [26, 19]);
    assert.deepEqual(labelVersion("Patch 26.19"), [26, 19]);
    assert.equal(labelVersion("Weekly reset"), undefined);
});

test("the latest known version comes from what the topic has already verified", () => {
    assert.deepEqual(latestKnownVersion(lolKnowledge(), "next-patch"), [26, 19]);
    assert.equal(latestKnownVersion(emptyKnowledge("lol", NOW), "next-patch"), undefined, "nothing verified yet: nothing to compare against");
});

test("only strictly older versions are obsolete, and only when both sides are known", () => {
    const latest = [26, 19];
    assert.match(obsoleteReason({ url: NOTES("26-10"), latest }) ?? "", /older than the verified 26\.19/);
    assert.equal(obsoleteReason({ url: NOTES("26-19"), latest }), undefined, "the current version may still announce the next one");
    assert.equal(obsoleteReason({ url: NOTES("26-20"), latest }), undefined);
    assert.equal(obsoleteReason({ url: SCHEDULE, latest }), undefined, "a page with no version is never rejected");
    assert.equal(obsoleteReason({ url: NOTES("26-10"), latest: undefined }), undefined, "nothing verified yet: never reject");
});

test("the rule is opt-in and only applies to questions about a future version", () => {
    const lolTopic = findTopic(findGame("lol"), "next-patch");
    assert.equal(rejectsOlderVersions(lolTopic), true, "League of Legends asks for the next patch");
    assert.equal(rejectsOlderVersions(findTopic(findGame("roblox"), "status")), false);
    assert.equal(rejectsOlderVersions(findTopic(findGame("cs2"), "last-update")), false, "not enabled where it was not reasoned about");

    const historical: Topic = { ...lolTopic, discovery: { ...lolTopic.discovery, answeredWhen: "usable-source" } };
    assert.equal(rejectsOlderVersions(historical), false, "a topic that needs any usable source keeps historical pages");
});

test("obsolete candidates are dropped before the model sees them, with the reason recorded", async () => {
    const game = findGame("lol");
    const topic = findTopic(game, "next-patch");
    const ai = countingAi();
    const search = new FixedSearch("sitemap", "official", [
        { url: NOTES("26-10"), title: "Patch 26.10 Notes" },
        { url: NOTES("26-11"), title: "Patch 26.11 Notes" },
        { url: SCHEDULE, title: "Patch Schedule - League of Legends" },
        { url: NOTES("26-20"), title: "Patch 26.20 Notes" }
    ]);

    const result = await discoverSources({ game, topic, knowledge: lolKnowledge(), now: NOW, officialProviders: [search], ai });

    const urls = result.official.map(c => c.url);
    assert.ok(urls.some(u => u.includes("patch-schedule")), "the schedule page survives");
    assert.ok(urls.some(u => u.includes("26-20")), "a newer patch survives");
    assert.ok(!urls.some(u => u.includes("26-10") || u.includes("26-11")), `older patch notes are gone: ${urls.join(", ")}`);
    assert.equal(result.rejected.filter(r => /older than the verified 26\.19/.test(r.reason)).length, 2, JSON.stringify(result.rejected));
    assert.equal(ai.calls, 0, "rejecting a candidate costs nothing");
});

test("without the opt-in, candidates are untouched", async () => {
    const game = findGame("lol");
    const topic: Topic = { ...findTopic(game, "next-patch"), discovery: { ...findTopic(game, "next-patch").discovery, rejectOlderVersions: false } };
    const search = new FixedSearch("sitemap", "official", [
        { url: NOTES("26-10"), title: "Patch 26.10 Notes" },
        { url: SCHEDULE, title: "Patch Schedule - League of Legends" }
    ]);

    const result = await discoverSources({ game, topic, knowledge: lolKnowledge(), now: NOW, officialProviders: [search] });
    assert.ok(result.official.some(c => c.url.includes("26-10")), "the filter changes nothing unless a topic opts in");
});

test("a learned page about an older patch is never fetched, rendered or read again", async () => {
    const game = findGame("lol");
    const topic = findTopic(game, "next-patch");
    const { store } = tempStore();

    // The topic has verified up to 26.19, and an old patch-notes page was learned earlier.
    const knowledge = lolKnowledge();
    const stale = NOTES("26-11");
    knowledge.discovered.push({
        id: discoveredSourceId("next-patch", stale), url: stale, topic: "next-patch", tier: "official", via: "seed",
        title: "Patch 26.11 Notes", discoveredAt: "2026-06-01T00:00:00.000Z", lastSuccessAt: "2026-06-01T00:00:00.000Z",
        successes: 1, failures: 0
    });
    store.save(knowledge);

    // The configured page is down, so without the filter the learned page would be fetched and read.
    const transport = routedTransport({ [LOL_PATCH_SCHEDULE_URL]: { status: 503, body: "" }, [SCHEDULE]: { status: 503, body: "" }, [stale]: { body: "<html><body>Patch 26.11 notes</body></html>" } });
    const ai = countingAi();
    const adapter = createAiDiscoveryAdapter(
        { description: LOL_NEXT_PATCH_SPEC.description, docTypes: [...LOL_NEXT_PATCH_SPEC.docTypes], itemKinds: [...LOL_NEXT_PATCH_SPEC.itemKinds] },
        { transport, ai: async () => ai, search: () => ({ official: [new FixedSearch("sitemap", "official", [])] }) }
    );

    // After 26.19 has passed the question is open again, so the adapter looks at everything it knows.
    const run = await runTracker(game, topic, adapter, store, new Date("2026-09-24T06:00:00Z"));

    const report = run.report as { skipped: Array<{ url: string; reason: string }> };
    assert.equal(report.skipped.length, 1, JSON.stringify(report.skipped));
    assert.match(report.skipped[0].reason, /older than the verified 26\.19/);
    assert.ok(!transport.gets.some(r => r.url === stale), `the obsolete page was fetched: ${transport.gets.map(r => r.url).join(", ")}`);
    assert.ok(!transport.renders.some(r => r.url === stale), "and never rendered either");
    assert.equal(ai.calls, 0, "and never read by the model");
    assert.equal(run.result.status, "stale", "stored knowledge is served instead");
});
