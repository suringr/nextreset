import test from "node:test";
import assert from "node:assert/strict";
import { loadGoldCases, loadMockScript, mockGoldProvider, renderMarkdown, runGoldEval } from "../ai/eval";

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
    assert.ok(lol.rejected.some(r => r.identity === "26.25" && /not found/.test(r.reason)));
    assert.ok(!lol.items.some(i => i.identity === "26.25" && i.facts.length > 0));

    const valorant = report.cases.find(c => c.id === "valorant-updates")!;
    assert.ok(valorant.rejected.some(r => r.value === "2026-08-19T13:00" && /day and month/.test(r.reason)));

    const synthetic = report.cases.find(c => c.id === "synthetic-no-date")!;
    assert.equal(synthetic.rejected.length, 1);
    assert.equal(synthetic.items[0].facts.length, 0);

    const pubg = report.cases.find(c => c.id === "pubg-article")!;
    const maintenance = pubg.items.find(i => /maintenance pc/i.test(i.identity))!;
    assert.deepEqual(maintenance.facts.map(f => [f.at, f.precision, f.timezone, f.yearInferred]), [["2026-03-11T00:00:00.000Z", "exact", "UTC", true]]);

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
    // The quote exists but does not mention the claimed date, so grounding still rejects it and the case passes.
    assert.equal(synthetic.passed, true);
    assert.ok(synthetic.rejected.some(r => /day and month/.test(r.reason)));
    assert.equal(report.summary.failed, 1);
});
