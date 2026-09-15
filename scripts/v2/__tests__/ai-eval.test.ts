import test from "node:test";
import assert from "node:assert/strict";
import { loadGoldCases, loadMockScript, mockGoldProvider, renderMarkdown, runGoldEval, validateGoldCases } from "../ai/eval";

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
