/**
 * League of Legends vertical slice: known source or discovery -> fetch/render ->
 * Gemini (mocked) -> grounding -> events/claims -> KnowledgeStore -> V1 view.
 * Real sitemap/seed providers and the real smart fetch run against routed
 * fixtures; only the model and the network are replaced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockAiProvider } from "../ai/mock";
import { AiJsonRequest, AiProvider } from "../ai/provider";
import { confidenceFor, createAiDiscoveryAdapter, eventFromItem } from "../adapters/ai-discovery";
import { MockSearchProvider, SearchProvider, SearchResult } from "../discovery/search-provider";
import { SeedPageSearch } from "../discovery/seed";
import { SitemapSearch } from "../discovery/sitemap";
import { Game, emptyKnowledge } from "../domain";
import { LOL_NEXT_PATCH_SPEC, LOL_PATCH_SCHEDULE_URL, adapterFor, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { validateGameKnowledge } from "../validate";
import { fixture } from "./fake-transport";
import { V1_ROBLOX_FRESH_KEYS, tempStore } from "./helpers";
import { RoutedTransport, routedTransport } from "./routed-transport";

const FINAL = "https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends";
const LISTING = "https://www.leagueoflegends.com/en-us/news/tags/patch-notes";
const NOW = new Date("2026-09-15T06:00:00Z");
const SPEC = { description: LOL_NEXT_PATCH_SPEC.description, docTypes: [...LOL_NEXT_PATCH_SPEC.docTypes], itemKinds: [...LOL_NEXT_PATCH_SPEC.itemKinds] };

const SCHEDULE_ITEMS = {
    items: [
        { kind: "version", label: "26.18", identity: "26.18", status: "released", fields: [{ field: "at", value: "2026-09-10", timezone: "", quote: "26.18 September 10, 2026 (Thursday)" }] },
        // A model label that repeats the kind word must not publish "Patch Patch 26.19".
        { kind: "version", label: "Patch 26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "", quote: "26.19 September 23, 2026" }] },
        { kind: "version", label: "26.20", identity: "26.20", status: "scheduled", fields: [{ field: "at", value: "2026-10-07", timezone: "", quote: "26.20 October 7, 2026" }] },
        // A hallucinated patch: not on the page, must be rejected by grounding.
        { kind: "version", label: "26.30", identity: "26.30", status: "scheduled", fields: [{ field: "at", value: "2026-12-30", timezone: "", quote: "26.30 December 30, 2026" }] }
    ]
};

function lolTransport(overrides: Parameters<typeof routedTransport>[0] = {}, renderOverrides: Parameters<typeof routedTransport>[1] = {}): RoutedTransport {
    const shell = fixture("riot-support-shell.html");
    const rendered = fixture("riot-support-patch-schedule-rendered.html");
    return routedTransport({
        [LOL_PATCH_SCHEDULE_URL]: { body: shell, finalUrl: FINAL },
        [FINAL]: { body: shell },
        "https://support.riotgames.com/robots.txt": { body: "User-agent: *\nDisallow:\n\nSitemap: https://support.riotgames.com/sitemap_index.xml\n", headers: { "content-type": "text/plain" } },
        "https://support.riotgames.com/sitemap_index.xml": { body: fixture("riot-support-sitemap-index.xml"), headers: { "content-type": "application/xml" } },
        "https://support.riotgames.com/sitemaps/en-us/sitemap.xml": { body: fixture("riot-support-sitemap-en-us.xml"), headers: { "content-type": "application/xml" } },
        [LISTING]: { body: fixture("lol-patch-notes-listing.html") },
        ...overrides
    }, {
        [LOL_PATCH_SCHEDULE_URL]: { html: rendered, finalUrl: FINAL },
        [FINAL]: { html: rendered },
        ...renderOverrides
    });
}

function lolAi(): MockAiProvider {
    return new MockAiProvider("gemini-mock", (req: AiJsonRequest) => {
        const schedule = /Document title: Patch Schedule - League of Legends/.test(req.prompt);
        if (req.label === "classify") {
            return schedule
                ? { relevant: true, docType: "patch-schedule", summary: "Riot's planned 2026 patch schedule." }
                : { relevant: false, docType: "unrelated", summary: "Not a schedule." };
        }
        if (req.label === "extract") return schedule ? SCHEDULE_ITEMS : { items: [] };
        throw new Error(`unexpected label ${req.label}`);
    });
}

function officialProviders(game: Game, transport: RoutedTransport): SearchProvider[] {
    return [
        new SitemapSearch({ hosts: game.discovery!.sitemapHosts!, transport, now: NOW }),
        new SeedPageSearch({ seeds: game.discovery!.seeds!, officialDomains: game.discovery!.officialDomains, transport, allowRender: false, now: NOW })
    ];
}

function lolAdapter(transport: RoutedTransport, ai: AiProvider | undefined, search?: (game: Game) => { official: SearchProvider[]; web?: SearchProvider }) {
    return createAiDiscoveryAdapter(SPEC, { transport, ai: async () => ai, search: game => search ? search(game) : { official: officialProviders(game, transport) } });
}

/** The production configuration, optionally without its configured page. */
function lolGame(withConfiguredUrl = true): Game {
    const game = findGame("lol");
    return withConfiguredUrl ? game : { ...game, sources: [] };
}

test("the configured page answers: fetch, render, classify, extract, ground, persist, and publish the V1 shape", async () => {
    const { store } = tempStore();
    const game = lolGame();
    const topic = findTopic(game, "next-patch");
    const transport = lolTransport();
    const ai = lolAi();

    const run = await runTracker(game, topic, lolAdapter(transport, ai), store, NOW);
    assert.equal(run.result.status, "fresh");
    const fresh = run.result as Extract<typeof run.result, { status: "fresh" }>;
    assert.equal(fresh.nextEventUtc, "2026-09-23T00:00:00.000Z");
    assert.equal(fresh.notes, "Patch 26.19");
    assert.equal(fresh.source_url, FINAL, "the discovered/final URL is published, not the configured one");
    assert.equal(fresh.confidence, "high");
    assert.equal(fresh.http_status, 200);
    assert.equal(fresh.fetch_mode, "browser");
    assert.deepEqual(Object.keys(fresh), V1_ROBLOX_FRESH_KEYS, "same key order as the V1 League of Legends provider");

    const k = store.load("lol");
    assert.deepEqual(k.events.map(e => [e.key, e.status, e.at, e.precision]), [
        ["lol/next-patch/26.18", "observed", "2026-09-10T00:00:00.000Z", "day"],
        ["lol/next-patch/26.19", "scheduled", "2026-09-23T00:00:00.000Z", "day"],
        ["lol/next-patch/26.20", "scheduled", "2026-10-07T00:00:00.000Z", "day"]
    ]);
    assert.equal(k.documents.length, 1);
    assert.equal(k.documents[0].url, FINAL);
    assert.equal(k.documents[0].fetchMode, "browser");
    assert.deepEqual(k.claims.map(c => [c.eventKey, c.field, c.value, c.method]), [
        ["lol/next-patch/26.18", "at", "2026-09-10T00:00:00.000Z", "ai"],
        ["lol/next-patch/26.19", "at", "2026-09-23T00:00:00.000Z", "ai"],
        ["lol/next-patch/26.20", "at", "2026-10-07T00:00:00.000Z", "ai"]
    ]);
    assert.equal(k.claims[1].quote, "26.19 September 23, 2026");
    assert.ok(k.claims.every(c => c.documentId === k.documents[0].id));
    assert.deepEqual(k.changes.map(c => [c.field, c.decision]), [["event", "applied"], ["event", "applied"], ["event", "applied"]]);
    assert.deepEqual(k.discovered.map(d => [d.url, d.via, d.successes]), [[FINAL, "config", 1]], "the page that answered is learned under its final URL");
    assert.equal(k.sources[0].id, "lol-patch-schedule");
    assert.equal(k.sources[0].lastMode, "browser");
    assert.doesNotThrow(() => validateGameKnowledge(JSON.parse(JSON.stringify(k))));

    const report = run.report as any;
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].outcome, "events");
    assert.equal(report.attempts[0].via, "config");
    assert.equal(report.attempts[0].extraction.rejected, 1, "the hallucinated 26.30 was rejected");
    assert.match(report.attempts[0].extraction.rejections[0].reason, /identity not found/);
    assert.equal(report.decision, undefined, "no discovery when the configured page answers");
    assert.equal(report.ai.calls, 2);
    assert.equal(report.confidence.level, "high");
    assert.ok(report.confidence.reasons.some((r: string) => /official page/.test(r)));
    assert.equal(ai.requests.map(r => r.label).join(","), "classify,extract");
});

test("an unchanged page costs no model call and records no change; a later run keeps the next patch current", async () => {
    const { store } = tempStore();
    const game = lolGame();
    const topic = findTopic(game, "next-patch");
    await runTracker(game, topic, lolAdapter(lolTransport(), lolAi()), store, NOW);

    const ai = lolAi();
    const again = await runTracker(game, topic, lolAdapter(lolTransport(), ai), store, new Date("2026-09-15T12:00:00Z"));
    assert.equal(again.result.status, "fresh");
    assert.equal(ai.requests.length, 0, "same rendered text hash: nothing to extract");
    assert.equal(again.changes.length, 0);
    assert.equal((again.result as any).nextEventUtc, "2026-09-23T00:00:00.000Z");
    assert.equal(store.load("lol").events.find(e => e.key === "lol/next-patch/26.19")?.lastVerified, "2026-09-15T12:00:00.000Z");

    // Once 26.19 has shipped, the next scheduled patch is published and 26.19 is marked ended.
    const later = await runTracker(game, topic, lolAdapter(lolTransport(), lolAi()), store, new Date("2026-09-24T06:00:00Z"));
    assert.equal((later.result as any).nextEventUtc, "2026-10-07T00:00:00.000Z");
    assert.equal((later.result as any).notes, "Patch 26.20");
    assert.equal(store.load("lol").events.find(e => e.key === "lol/next-patch/26.19")?.status, "ended");
});

test("without any configured page, discovery finds the schedule through the official sitemap and learns it", async () => {
    const { store } = tempStore();
    const game = lolGame(false);
    const topic = findTopic(game, "next-patch");
    const transport = lolTransport();
    const web = new MockSearchProvider("duckduckgo", "web", {});

    const run = await runTracker(game, topic, lolAdapter(transport, lolAi(), g => ({ official: officialProviders(g, transport), web })), store, NOW);
    assert.equal(run.result.status, "fresh");
    assert.equal((run.result as any).nextEventUtc, "2026-09-23T00:00:00.000Z");
    assert.equal((run.result as any).source_url, FINAL);
    const report = run.report as any;
    assert.deepEqual(report.knownSources, []);
    assert.equal(report.decision.discover, true);
    assert.ok(report.discovery.queries.some((q: any) => q.provider === "sitemap" && /patch schedule/.test(q.query)));
    assert.equal(report.discovery.searchedWeb, false, "official channels were convincing; the web was not asked");
    assert.equal(web.queries.length, 0);
    assert.equal(report.discovery.candidates[0].url, FINAL);
    assert.equal(report.winner.via, "sitemap");
    const k = store.load("lol");
    assert.deepEqual(k.discovered.map(d => [d.url, d.via, d.query]), [[FINAL, "sitemap", "League of Legends patch schedule"]]);
    assert.equal(k.events.length, 3);
});

test("when the configured page is removed later, the learned page answers without any search", async () => {
    const { store } = tempStore();
    await runTracker(lolGame(), findTopic(lolGame(), "next-patch"), lolAdapter(lolTransport(), lolAi()), store, NOW);

    const game = lolGame(false);
    const noSearch = { official: [new MockSearchProvider("sitemap", "official", { "League of Legends patch schedule": "budget" })], web: new MockSearchProvider("duckduckgo", "web", { "League of Legends patch schedule": "challenge" }) };
    const run = await runTracker(game, findTopic(game, "next-patch"), lolAdapter(lolTransport(), lolAi(), () => noSearch), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(run.result.status, "fresh");
    const report = run.report as any;
    assert.deepEqual(report.knownSources, [{ url: FINAL, via: "learned" }]);
    assert.equal(report.decision, undefined, "no discovery needed");
    assert.equal(noSearch.official[0].queries.length, 0);
    assert.equal(store.load("lol").discovered[0].successes, 2);
});

test("a dead configured page is recovered by discovery, and its failure is recorded", async () => {
    const { store } = tempStore();
    const game = lolGame();
    const topic = findTopic(game, "next-patch");
    const transport = lolTransport({ [LOL_PATCH_SCHEDULE_URL]: { status: 404, body: "<html><body>gone</body></html>" } });

    const run = await runTracker(game, topic, lolAdapter(transport, lolAi()), store, NOW);
    assert.equal(run.result.status, "fresh");
    const report = run.report as any;
    assert.equal(report.attempts[0].outcome, "unusable");
    assert.equal(report.attempts[0].via, "config");
    assert.equal(report.decision.discover, true);
    assert.match(report.decision.reason, /no known source was usable/);
    assert.equal(report.winner.via, "sitemap");
    assert.equal(report.winner.url, FINAL);
    const k = store.load("lol");
    assert.equal(k.sources.find(s => s.id === "lol-patch-schedule")?.consecutiveFailures, 1);
    assert.equal(k.discovered[0].via, "sitemap");
});

test("without an AI provider the run fails cleanly and stored knowledge is served stale", async () => {
    const { store } = tempStore();
    const game = lolGame();
    const topic = findTopic(game, "next-patch");
    await runTracker(game, topic, lolAdapter(lolTransport(), lolAi()), store, NOW);

    // The page changed (a different rendered document), so extraction is needed and there is no model.
    const changed = { html: fixture("minecraft-article.html"), finalUrl: FINAL };
    const run = await runTracker(game, topic, lolAdapter(lolTransport({}, { [LOL_PATCH_SCHEDULE_URL]: changed, [FINAL]: changed }), undefined), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(run.result.status, "stale");
    assert.match((run.result as any).reason, /AI provider not configured/);
    assert.equal((run.result as any).nextEventUtc, "2026-09-23T00:00:00.000Z");
    assert.equal((run.report as any).attempts[0].outcome, "no-ai");

    const empty = await runTracker(game, topic, lolAdapter(lolTransport(), undefined), tempStore().store, NOW);
    assert.equal(empty.result.status, "unavailable");
});

test("a non-official page is never evidence; it may only lead to the official page (with lower confidence)", async () => {
    const reddit = "https://www.reddit.com/r/leagueoflegends/comments/abc/patch_schedule";
    const redditHit = { url: reddit, title: "League of Legends patch schedule?", snippet: "when is 26.19?", rank: 1, provider: "duckduckgo" };
    const evil = { url: "https://evil-riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends", title: "Patch Schedule", rank: 2, provider: "duckduckgo" };
    const game: Game = { ...lolGame(false), discovery: { officialDomains: ["riotgames.com", "leagueoflegends.com"] } };
    const topic = findTopic(game, "next-patch");
    const web = (hits: SearchResult[]) => ({ official: [] as SearchProvider[], web: new MockSearchProvider("duckduckgo", "web", { "site:riotgames.com League of Legends patch schedule": [], "site:leagueoflegends.com League of Legends patch schedule": [], "League of Legends patch schedule": hits }) });

    // Nothing official reachable: no events, nothing persisted, a clean failure.
    const body = (link: string) => `<html><head><title>League of Legends patch schedule?</title></head><body><main><p>${"Does anyone know when 26.19 ships? ".repeat(8)}${link}</p></main></body></html>`;
    const dead = tempStore();
    const none = await runTracker(game, topic, lolAdapter(lolTransport({ [reddit]: { body: body("") } }), lolAi(), () => web([redditHit, evil])), dead.store, NOW);
    assert.equal(none.result.status, "unavailable");
    assert.ok((none.result as any).explanation.includes("no official page found by discovery (2 candidate(s), web searched)"), (none.result as any).explanation);
    const k0 = dead.store.load("lol");
    assert.deepEqual([k0.events, k0.documents, k0.claims, k0.discovered], [[], [], [], []]);
    const r0 = none.report as any;
    assert.ok(r0.discovery.candidates.every((c: any) => c.tier === "secondary"), "the look-alike domain is secondary too");
    assert.equal(r0.attempts.length, 0, "secondary pages are never fetched for extraction");

    // The same page linking to Riot leads to the official page, which is what gets published and learned.
    const { store } = tempStore();
    const linked = await runTracker(game, topic, lolAdapter(lolTransport({ [reddit]: { body: body(`<a href="${FINAL}/">Riot's patch schedule</a>`) } }), lolAi(), () => web([redditHit])), store, NOW);
    assert.equal(linked.result.status, "fresh");
    assert.equal((linked.result as any).source_url, FINAL);
    assert.equal((linked.result as any).confidence, "medium");
    const r1 = linked.report as any;
    assert.equal(r1.winner.via, "secondary-link");
    assert.ok(r1.confidence.reasons.some((x: string) => /non-official page's link/.test(x)));
    const k1 = store.load("lol");
    assert.deepEqual(k1.discovered.map(d => [d.url, d.via, d.tier]), [[FINAL, "secondary-link", "official"]]);
    assert.ok(k1.documents.every(d => d.url === FINAL));
});

test("grounded items become events with deterministic statuses, and confidence explains itself", () => {
    const game = lolGame();
    const topic = findTopic(game, "next-patch");
    const fact = (field: "at" | "startAt" | "endAt", at: string, precision: "exact" | "day" = "day", yearInferred = false) => ({ field, value: at.slice(0, 10), at, precision, quote: "q", yearInferred, timezoneRaw: "" });
    const item = (identity: string, status: any, facts: any[], kind: any = "version") => ({ kind, label: identity, identity, identityKey: identity, status, facts });

    const scheduled = eventFromItem(item("26.19", "scheduled", [fact("at", "2026-09-23T00:00:00.000Z")]), topic, SPEC, "doc", NOW, 730) as any;
    assert.equal(scheduled.event.status, "scheduled");
    assert.equal(scheduled.claims[0].eventKey, "lol/next-patch/26.19");
    const released = eventFromItem(item("26.18", "released", [fact("at", "2026-09-10T00:00:00.000Z")]), topic, SPEC, "doc", NOW, 730) as any;
    assert.equal(released.event.status, "observed");
    assert.equal((eventFromItem(item("26.19", "unknown", [fact("at", "2026-09-23T00:00:00.000Z")]), topic, SPEC, "doc", NOW, 730) as any).event.status, "scheduled", "a future date is a schedule even when the model is unsure");
    assert.deepEqual(eventFromItem(item("26.19", "scheduled", []), topic, SPEC, "doc", NOW, 730), { skipped: "no accepted date fact" });
    assert.match((eventFromItem(item("26.19", "scheduled", [fact("at", "2031-09-23T00:00:00.000Z")]), topic, SPEC, "doc", NOW, 730) as any).skipped, /days from now/);
    assert.match((eventFromItem(item("PC maintenance", "scheduled", [fact("at", "2026-09-23T00:00:00.000Z")], "occurrence"), topic, SPEC, "doc", NOW, 730) as any).skipped, /kind occurrence not accepted/);

    const doc = { url: FINAL, finalUrl: FINAL, status: 200, fetchedAt: NOW.toISOString(), mode: "browser" as const, title: "t", text: "x", textHash: "h", body: "" };
    const extraction = (repaired: boolean, yearInferred: boolean) => ({ raw: { items: [], dropped: 0 }, grounded: { items: [item("26.19", "scheduled", [fact("at", "2026-09-23T00:00:00.000Z", "day", yearInferred)])], rejected: [], stats: { fields: 1, accepted: 1, rejected: 0, itemsDropped: 0, itemsRejected: 0 } }, usage: { inputTokens: 1, outputTokens: 1 }, truncated: false, attempts: repaired ? 2 : 1, repaired });
    const high = confidenceFor({ via: "config", document: doc, extraction: extraction(false, false) as any, events: [scheduled.event] });
    assert.equal(high.level, "high");
    assert.ok(high.reasons.some(r => /known to the day only/.test(r)));
    assert.equal(confidenceFor({ via: "config", document: doc, extraction: extraction(true, false) as any, events: [scheduled.event] }).level, "medium");
    assert.equal(confidenceFor({ via: "sitemap", document: doc, extraction: extraction(false, true) as any, events: [scheduled.event] }).level, "medium");
    assert.equal(confidenceFor({ via: "web", document: doc, extraction: extraction(false, false) as any, events: [scheduled.event] }).level, "medium");
});

test("the production registry wires League of Legends to the evidence-based adapter", () => {
    const game = findGame("lol");
    assert.equal(game.sources[0].url, LOL_PATCH_SCHEDULE_URL);
    assert.deepEqual(game.discovery?.officialDomains, ["riotgames.com", "leagueoflegends.com"]);
    assert.equal(typeof adapterFor(findTopic(game, "next-patch")), "function");
    assert.ok(emptyKnowledge("lol").discovered.length === 0);
});
