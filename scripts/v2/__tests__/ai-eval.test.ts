import test from "node:test";
import assert from "node:assert/strict";
import { loadGoldCases, loadMockScript, matchesIdentity, mockGoldProvider, renderMarkdown, runGoldEval, validateGoldCases } from "../ai/eval";
import { GroundedItem } from "../ai/extraction";

test("gold identities match as complete tokens, never as substrings", () => {
    const item = (identity: string, label = identity): GroundedItem => ({ kind: "version", label, identity, identityKey: identity.toLowerCase().replace(/[^a-z0-9]+/g, "-"), status: "scheduled", facts: [] });
    assert.equal(matchesIdentity(item("Patch 26.19"), ["26.19"]), true);
    assert.equal(matchesIdentity(item("Patch 26.19"), ["6.19"]), false);
    assert.equal(matchesIdentity(item("Patch 26.19"), ["26.1"]), false);
    assert.equal(matchesIdentity(item("Update 43.1: Sunlit Skies"), ["update 43.1"]), true);
    assert.equal(matchesIdentity(item("Season 05"), ["05"]), true);
    assert.equal(matchesIdentity(item("Season 105"), ["05"]), false);
    assert.equal(matchesIdentity(item("Live Maintenance PC March 11", "PC"), ["pc maintenance"]), true, "token order does not matter");
    assert.equal(matchesIdentity(item("26.44/45 Hotfix"), ["26.44/45"]), true);
    assert.equal(matchesIdentity(item("x", "Counter-Strike 2 Update"), ["september 10, 2026", "counter-strike 2 update"]), true, "the label may satisfy an alias");
});

test("every gold case passes with the scripted responses, and hallucinated fields are rejected", async () => {
    const cases = loadGoldCases();
    const provider = mockGoldProvider(loadMockScript(), cases);
    const report = await runGoldEval({ provider, cases, mode: "mock" });

    const failed = report.cases.filter(c => !c.passed).map(c => `${c.id}: ${c.failures.join(" | ")}`);
    assert.deepEqual(failed, []);
    assert.equal(report.summary.cases, cases.length);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.calls, cases.length * 2);
    assert.equal(report.summary.failures, 0);

    // The scripts deliberately contain unsupported claims; grounding must have thrown them out.
    const lol = report.cases.find(c => c.id === "lol-schedule")!;
    assert.ok(lol.rejected.some(r => r.identity === "26.25" && /identity not found/.test(r.reason)), "a patch the page never lists is rejected");
    assert.ok(!lol.items.some(i => i.identity === "26.25"));
    assert.ok(lol.rejected.some(r => r.identity === "99.99" && /identity not found/.test(r.reason)), "a fabricated identity with a real quote is rejected");
    assert.ok(!lol.items.some(i => i.identity === "99.99"));

    const minecraft = report.cases.find(c => c.id === "minecraft-article")!;
    assert.ok(minecraft.rejected.some(r => r.identity === "26.44" && /does not mention the item/.test(r.reason)), "a posting date not tied to the version is not evidence for it");

    const listing = report.cases.find(c => c.id === "lol-notes-listing")!;
    assert.deepEqual(listing.items.find(i => i.identity === "26.18")!.facts.map(f => [f.at, f.precision]), [["2026-09-09T18:00:00.000Z", "exact"]]);

    const valorant = report.cases.find(c => c.id === "valorant-updates")!;
    assert.ok(valorant.rejected.some(r => r.value === "2026-08-19T13:00" && /day and month/.test(r.reason)));

    const synthetic = report.cases.find(c => c.id === "synthetic-no-date")!;
    assert.equal(synthetic.rejected.length, 1);
    assert.equal(synthetic.items[0].facts.length, 0);

    const pubg = report.cases.find(c => c.id === "pubg-article")!;
    const maintenance = pubg.items.find(i => /maintenance pc/i.test(i.identity))!;
    assert.deepEqual(maintenance.facts.map(f => [f.at, f.precision, f.timezone, f.yearInferred]), [["2026-03-11T00:00:00.000Z", "exact", "UTC", true]]);

    // Exact-precision expectations must name the instant they expect.
    assert.throws(() => validateGoldCases([{ ...cases[0], expect: [{ identityAnyOf: ["x"], date: "2026-01-01", precision: "exact" }] }]), /requires precision exact but gives no `at`/);
    assert.doesNotThrow(() => validateGoldCases(cases));

    const genshin = report.cases.find(c => c.id === "genshin-article")!;
    assert.equal(genshin.items[0].facts[0].yearInferred, true);

    const md = renderMarkdown(report);
    assert.match(md, /gold evaluation \(mock\)/);
    assert.match(md, /✅ lol-schedule/);
    assert.match(md, /rejected: 26\.25/);
});

test("a wrong or missing answer fails its case with a readable reason", async () => {
    const cases = loadGoldCases().filter(c => c.id === "lol-schedule" || c.id === "synthetic-no-date");
    const script = loadMockScript();
    // Drop 26.19 and make the synthetic case hallucinate a quote that does occur in its document.
    const broken = JSON.parse(JSON.stringify(script)) as Record<string, any>;
    broken["lol-schedule:extract"].items = broken["lol-schedule:extract"].items.filter((i: { identity: string }) => i.identity !== "26.19");
    broken["synthetic-no-date:extract"].items[0].fields[0] = { field: "at", value: "2026-10-01", timezone: "", quote: "No release date has been announced yet" };

    const report = await runGoldEval({ provider: mockGoldProvider(broken, cases), cases, mode: "mock" });
    const lol = report.cases.find(c => c.id === "lol-schedule")!;
    assert.equal(lol.passed, false);
    assert.ok(lol.failures.some(f => /no item with identity 26\.19/.test(f)));

    const synthetic = report.cases.find(c => c.id === "synthetic-no-date")!;
    // The quote exists but neither names the patch nor states the claimed date, so grounding rejects it and the case passes.
    assert.equal(synthetic.passed, true);
    assert.ok(synthetic.rejected.some(r => /does not mention/.test(r.reason)));
    assert.equal(report.summary.failed, 1);
});

test("a case whose calls fail meets none of its expectations", async () => {
    const cases = loadGoldCases().filter(c => c.id === "lol-schedule" || c.id === "genshin-article");
    const inner = mockGoldProvider(loadMockScript(), cases);
    const failing = { name: "mock", model: "mock", generateJson: async (req: { prompt: string }) => {
        if (/^Game: League of Legends/m.test(req.prompt)) throw new Error("simulated provider outage");
        return inner.generateJson(req as any);
    } };
    const report = await runGoldEval({ provider: failing as any, cases, mode: "mock" });
    const lol = report.cases.find(c => c.id === "lol-schedule")!;
    assert.equal(lol.passed, false);
    assert.match(lol.error ?? "", /simulated provider outage/);
    const count = (id: string) => { const c = cases.find(x => x.id === id)!; return c.expect.length + (c.classification ? 1 : 0) + (c.noDates ? 1 : 0) + (c.noItemsMatching ? 1 : 0); };
    const lolExpectations = count("lol-schedule");
    const genshinExpectations = count("genshin-article");
    assert.equal(report.summary.expectations, lolExpectations + genshinExpectations);
    assert.equal(report.summary.expectationsMet, genshinExpectations, "the errored case is credited with nothing");
});
