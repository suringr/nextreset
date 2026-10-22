/**
 * Re-reads that cost money and learned nothing.
 *
 * Between 15 September and 14 October 2026 the production ledger shows Riot's patch schedule sent to the
 * model on five separate days, twice on two of them, and all six stored documents produced the identical
 * 24 claims. The page's text ends with a "Related Articles" list that Riot rotates as it edits *other*
 * articles: the committed fixture reads "League Classic brings back the Rune and Mastery systems", the live
 * page on 22 October 2026 read "League Classic is available thro…". The full-text hash changed with it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockAiProvider } from "../ai/mock";
import { AiJsonRequest, AiProvider } from "../ai/provider";
import { createAiDiscoveryAdapter } from "../adapters/ai-discovery";
import { SeedPageSearch } from "../discovery/seed";
import { SitemapSearch } from "../discovery/sitemap";
import { Game } from "../domain";
import { LOL_NEXT_PATCH_SPEC, LOL_PATCH_SCHEDULE_URL, findGame, findTopic } from "../games";
import { runTracker } from "../pipeline";
import { fixture } from "./fake-transport";
import { tempStore } from "./helpers";
import { RoutedTransport, routedTransport } from "./routed-transport";

const FINAL = "https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends";
const NOW = new Date("2026-09-15T06:00:00Z");
const RENDERED = fixture("riot-support-patch-schedule-rendered.html");
const RELATED_SNIPPET = "League Classic brings back the Rune and Mastery systems, gi";

const BASE_SPEC = { description: LOL_NEXT_PATCH_SPEC.description, docTypes: [...LOL_NEXT_PATCH_SPEC.docTypes], itemKinds: [...LOL_NEXT_PATCH_SPEC.itemKinds] };
const PRODUCTION_SPEC = { ...BASE_SPEC, trailingBoilerplate: LOL_NEXT_PATCH_SPEC.trailingBoilerplate };

const ITEMS = {
    items: [
        { kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "", quote: "26.19 September 23, 2026" }] },
        { kind: "version", label: "26.20", identity: "26.20", status: "scheduled", fields: [{ field: "at", value: "2026-10-07", timezone: "", quote: "26.20 October 7, 2026" }] }
    ]
};

function lolAi(): MockAiProvider {
    return new MockAiProvider("gemini-3.5-flash", (req: AiJsonRequest) => {
        if (req.label === "classify") return { relevant: true, docType: "patch-schedule", summary: "Riot's planned patch schedule." };
        if (req.label === "extract") return ITEMS;
        throw new Error(`unexpected label ${req.label}`);
    });
}

function renderedAs(html: string): RoutedTransport {
    const shell = fixture("riot-support-shell.html");
    return routedTransport(
        { [LOL_PATCH_SCHEDULE_URL]: { body: shell, finalUrl: FINAL }, [FINAL]: { body: shell } },
        { [LOL_PATCH_SCHEDULE_URL]: { html, finalUrl: FINAL }, [FINAL]: { html } }
    );
}

function adapter(spec: typeof BASE_SPEC, transport: RoutedTransport, ai: AiProvider) {
    const search = (game: Game) => ({
        official: [
            new SitemapSearch({ hosts: game.discovery!.sitemapHosts!, transport, now: NOW }),
            new SeedPageSearch({ seeds: game.discovery!.seeds!, officialDomains: game.discovery!.officialDomains, transport, allowRender: false, now: NOW })
        ]
    });
    return createAiDiscoveryAdapter(spec, { transport, ai: async () => ai, search });
}

const game = findGame("lol");
const topic = findTopic(game, "next-patch");
const scheduleSource = (store: ReturnType<typeof tempStore>["store"]) => store.load("lol").sources.find(s => s.id === "lol-patch-schedule");

test("production configures the Related Articles marker for the schedule", () => {
    assert.deepEqual([...(LOL_NEXT_PATCH_SPEC.trailingBoilerplate ?? [])], ["Related Articles"]);
    assert.ok(RENDERED.includes(RELATED_SNIPPET), "fixture still carries the related-articles snippet these tests edit");
});

test("a change only in Riot's rotating Related Articles list costs no model call", async () => {
    const { store } = tempStore();
    const first = lolAi();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(RENDERED), first), store, NOW);
    assert.equal(first.requests.length, 2, "the first read is extracted");
    const fingerprint = scheduleSource(store)?.contentFingerprint;
    assert.ok(fingerprint, "the fingerprint is stored with the source");

    const rotated = RENDERED.replace(RELATED_SNIPPET, "League Classic is available through the end of the year, then retu");
    const ai = lolAi();
    const again = await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(rotated), ai), store, new Date("2026-09-15T12:00:00Z"));
    assert.equal(ai.requests.length, 0, "only text after the article changed: nothing to extract");
    assert.equal(again.result.status, "fresh");
    assert.equal(again.changes.length, 0);
    const attempt = (again.report as any).attempts[0];
    assert.equal(attempt.outcome, "unchanged");
    assert.match(attempt.reason, /after the page's own content/);
    assert.equal(scheduleSource(store)?.contentFingerprint, fingerprint);

    // The rotated text is now the stored full-text hash: the next identical read is a plain unchanged.
    const third = lolAi();
    const settled = await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(rotated), third), store, new Date("2026-09-15T18:00:00Z"));
    assert.equal(third.requests.length, 0);
    assert.equal((settled.report as any).attempts[0].reason, undefined, "same full text, no fingerprint needed");
});

test("a real schedule edit before the list is still read, even when the list changed too", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(RENDERED), lolAi()), store, NOW);

    const edited = RENDERED.replace(">October 7, 2026<", ">October 8, 2026<").replace(RELATED_SNIPPET, "Something else entirely about another article, its first line");
    assert.ok(edited.includes(">October 8, 2026<"), "the schedule edit landed");
    const ai = lolAi();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(edited), ai), store, new Date("2026-09-15T12:00:00Z"));
    // The mock still quotes "October 7", which the edited page no longer says, so grounding asks for a repair
    // as well; what matters here is that the changed schedule reached the model at all.
    assert.deepEqual(ai.requests.map(r => r.label).slice(0, 2), ["classify", "extract"], "a changed schedule goes back to the model");
});

test("a source stored before fingerprints existed gains one without a model call", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(RENDERED), lolAi()), store, NOW);
    // The production knowledge branch at rollout: sources carry a text hash and no fingerprint.
    const k = store.load("lol");
    for (const s of k.sources) delete s.contentFingerprint;
    store.save(k);
    assert.equal(scheduleSource(store)?.contentFingerprint, undefined);

    const ai = lolAi();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(RENDERED), ai), store, new Date("2026-09-15T12:00:00Z"));
    assert.equal(ai.requests.length, 0, "rollout costs nothing: the page is unchanged by its full hash");
    assert.ok(scheduleSource(store)?.contentFingerprint, "the fingerprint is recorded from that read");

    const rotated = RENDERED.replace(RELATED_SNIPPET, "Yet another rotation of the related list, unrelated to the schedul");
    const later = lolAi();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(rotated), later), store, new Date("2026-09-15T18:00:00Z"));
    assert.equal(later.requests.length, 0);
});

test("a source with validators and no fingerprint is read once without them, so a 304 cannot leave it unfingerprinted", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(RENDERED), lolAi()), store, NOW);
    const k = store.load("lol");
    for (const s of k.sources) {
        delete s.contentFingerprint;
        s.etag = 'W/"schedule-v1"';
    }
    store.save(k);

    // A server that honours validators: with an ETag it answers 304 and sends no body.
    const conditional = (inner: RoutedTransport): RoutedTransport => ({
        ...inner,
        gets: inner.gets,
        renders: inner.renders,
        async get(req) {
            if (req.etag) { inner.gets.push(req); return { status: 304, finalUrl: req.url, headers: {}, body: "", notModified: true, elapsedMs: 1 }; }
            return inner.get(req);
        }
    });
    const migration = conditional(renderedAs(RENDERED));
    const ai = lolAi();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, migration, ai), store, new Date("2026-09-15T12:00:00Z"));
    assert.equal(ai.requests.length, 0, "the page is unchanged by its full hash");
    assert.ok(migration.gets.some(g => g.url === LOL_PATCH_SCHEDULE_URL && !g.etag), "the migration read went out without validators");
    assert.ok(scheduleSource(store)?.contentFingerprint, "and recorded the fingerprint");

    // With a fingerprint stored, requests are conditional again: no further unconditional reads.
    const after = conditional(renderedAs(RENDERED));
    const k2 = store.load("lol");
    for (const s of k2.sources) s.etag = 'W/"schedule-v1"';
    store.save(k2);
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, after, lolAi()), store, new Date("2026-09-15T18:00:00Z"));
    assert.ok(after.gets.filter(g => g.url === LOL_PATCH_SCHEDULE_URL).every(g => g.etag), "conditional once migrated");

    const rotated = RENDERED.replace(RELATED_SNIPPET, "The first rotation after rollout, which must not reach the model.");
    const later = lolAi();
    await runTracker(game, topic, adapter(PRODUCTION_SPEC, renderedAs(rotated), later), store, new Date("2026-09-16T06:00:00Z"));
    assert.equal(later.requests.length, 0);
});

test("without a marker any text change is a change, so other pages behave exactly as before", async () => {
    const { store } = tempStore();
    await runTracker(game, topic, adapter(BASE_SPEC, renderedAs(RENDERED), lolAi()), store, NOW);
    const rotated = RENDERED.replace(RELATED_SNIPPET, "A rotation an unconfigured adapter must still treat as a change.");
    const ai = lolAi();
    await runTracker(game, topic, adapter(BASE_SPEC, renderedAs(rotated), ai), store, new Date("2026-09-15T12:00:00Z"));
    assert.equal(ai.requests.length, 2);
});
