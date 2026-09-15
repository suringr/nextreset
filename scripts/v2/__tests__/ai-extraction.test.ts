import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DOCUMENT_CHARS, classifyDocument, extractFacts, groundExtraction, parseClassification, parseRawItems, quoteOccursIn } from "../ai/extraction";
import { MockAiProvider, scriptedResponder } from "../ai/mock";

const topic = { game: "lol", gameName: "League of Legends", type: "next-patch", description: "Patch numbers and their scheduled dates." };
const doc = {
    url: "https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends/",
    title: "Patch Schedule - League of Legends",
    text: "Patch Scheduled Date (Pacific Time) 26.18 September 10, 2026 (Thursday) 26.19 September 23, 2026 26.20 October 7, 2026 Note: patch dates can change. Version 7.1 “A Rekviem” launches on September 23!"
};

test("parseRawItems keeps schema-conformant items and drops the rest", () => {
    const { items, dropped } = parseRawItems({
        items: [
            { kind: "version", label: "Patch 26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "PT", quote: "26.19 September 23, 2026" }] },
            { kind: "banner", label: "bad kind", identity: "x", status: "unknown", fields: [] },
            { kind: "version", label: "no identity", identity: "", status: "unknown", fields: [] },
            { kind: "version", label: "bad field", identity: "26.20", status: "nonsense", fields: [{ field: "when", value: "2026-10-07", quote: "x" }, "junk"] },
            "junk"
        ]
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].identity, "26.19");
    assert.equal(items[1].identity, "26.20");
    assert.equal(items[1].status, "unknown");
    assert.equal(items[1].fields.length, 0);
    assert.equal(dropped, 5);
    assert.deepEqual(parseRawItems(null), { items: [], dropped: 0 });
});

test("quoteOccursIn tolerates whitespace, curly quotes, dashes and punctuation differences", () => {
    assert.equal(quoteOccursIn("26.19   September 23, 2026", doc.text), true);
    assert.equal(quoteOccursIn("Version 7.1 \"A Rekviem\" launches on September 23!", doc.text), true);
    assert.equal(quoteOccursIn("26.19 September 23 2026", doc.text), true);
    assert.equal(quoteOccursIn("26.25 December 23, 2026", doc.text), false);
    assert.equal(quoteOccursIn("26.", doc.text), false, "too short to count as evidence");
});

test("groundExtraction accepts supported facts and rejects unsupported ones with reasons", () => {
    const raw = parseRawItems({
        items: [
            { kind: "version", label: "Patch 26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "Pacific Time", quote: "26.19 September 23, 2026" }] },
            { kind: "version", label: "Patch 26.25", identity: "26.25", status: "scheduled", fields: [{ field: "at", value: "2026-12-23", timezone: "PT", quote: "26.25 December 23, 2026" }] },
            { kind: "version", label: "Patch 26.20", identity: "26.20", status: "scheduled", fields: [{ field: "at", value: "2026-10-08", timezone: "PT", quote: "26.20 October 7, 2026" }] },
            { kind: "version", label: "Patch 26.18", identity: "26.18", status: "released", fields: [{ field: "at", value: "2025-09-10", timezone: "PT", quote: "26.18 September 10, 2026 (Thursday)" }] },
            { kind: "period", label: "Version 7.1", identity: "Version 7.1", status: "scheduled", fields: [{ field: "startAt", value: "2026-09-23", timezone: "", quote: "Version 7.1 \"A Rekviem\" launches on September 23!" }] },
            { kind: "version", label: "Bad value", identity: "26.21", status: "scheduled", fields: [{ field: "at", value: "October 21", timezone: "", quote: "26.19 September 23, 2026" }] },
            { kind: "version", label: "No quote", identity: "26.22", status: "scheduled", fields: [{ field: "at", value: "2026-11-04", timezone: "", quote: "" }] },
            { kind: "version", label: "Timed", identity: "26.23", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "Pacific Time", quote: "26.19 September 23, 2026" }] },
            { kind: "version", label: "Bad identity", identity: "!!!", status: "unknown", fields: [] }
        ]
    });
    const grounded = groundExtraction(raw, doc.text);

    const byIdentity = Object.fromEntries(grounded.items.map(i => [i.identity, i]));
    assert.deepEqual(byIdentity["26.19"].facts.map(f => [f.field, f.at, f.precision, f.timezone, f.yearInferred]), [["at", "2026-09-23T00:00:00.000Z", "day", "America/Los_Angeles", false]]);
    assert.equal(byIdentity["26.25"].facts.length, 0);
    assert.equal(byIdentity["26.20"].facts.length, 0);
    assert.equal(byIdentity["26.18"].facts.length, 0);
    assert.deepEqual(byIdentity["Version 7.1"].facts.map(f => [f.field, f.at, f.precision, f.yearInferred]), [["startAt", "2026-09-23T00:00:00.000Z", "day", true]]);
    assert.equal(byIdentity["Version 7.1"].identityKey, "version-7.1");
    assert.equal(byIdentity["26.21"].facts.length, 0);
    assert.equal(byIdentity["26.22"].facts.length, 0);
    assert.deepEqual(byIdentity["26.23"].facts.map(f => [f.at, f.precision]), [["2026-09-23T22:00:00.000Z", "exact"]]);
    assert.equal("!!!" in byIdentity, false);

    const reasons = Object.fromEntries(grounded.rejected.map(r => [`${r.identity}`, r.reason]));
    assert.match(reasons["26.25"], /quote not found/);
    assert.match(reasons["26.20"], /does not mention the claimed day/);
    assert.match(reasons["26.18"], /different year/);
    assert.match(reasons["26.21"], /not an ISO date/);
    assert.match(reasons["26.22"], /quote missing/);
    assert.match(reasons["!!!"], /identity cannot be normalized/);
    assert.deepEqual(grounded.stats, { fields: 8, accepted: 3, rejected: 6, itemsDropped: 0 });
});

test("classifyDocument and extractFacts send the topic, the date and the document, and ground the answer", async () => {
    const provider = new MockAiProvider("mock", scriptedResponder({
        classify: { relevant: true, docType: "patch-schedule", summary: "Schedule.", reason: "Lists dates." },
        extract: { items: [{ kind: "version", label: "Patch 26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "Pacific Time", quote: "26.19 September 23, 2026" }] }] }
    }), { inputTokens: 1200, outputTokens: 80 });
    const now = new Date("2026-09-14T21:30:00Z");

    const { classification, usage } = await classifyDocument(provider, topic, doc, { now });
    assert.deepEqual(classification, { relevant: true, docType: "patch-schedule", summary: "Schedule.", reason: "Lists dates." });
    assert.deepEqual(usage, { inputTokens: 1200, outputTokens: 80 });
    const classifyRequest = provider.requests[0];
    assert.equal(classifyRequest.label, "classify");
    assert.ok(classifyRequest.prompt.includes("Game: League of Legends (lol)\nTopic: next-patch\n"));
    assert.ok(classifyRequest.prompt.includes("Today's date (UTC): 2026-09-14"));
    assert.ok(classifyRequest.prompt.includes(doc.text));
    assert.ok(!classifyRequest.prompt.includes(doc.url), "the model never sees a URL it could echo as evidence");
    assert.equal(classifyRequest.schema.type, "object");

    const extraction = await extractFacts(provider, topic, doc, { now });
    assert.equal(provider.requests[1].label, "extract");
    assert.equal(extraction.truncated, false);
    assert.equal(extraction.grounded.items.length, 1);
    assert.equal(extraction.grounded.items[0].facts[0].at, "2026-09-23T00:00:00.000Z");

    assert.deepEqual(parseClassification({ relevant: "yes", docType: "poem" }), { relevant: false, docType: "unrelated", summary: "", reason: "" });
});

test("very long documents are truncated before the model sees them and grounded against what it saw", async () => {
    const long = { ...doc, text: "26.19 September 23, 2026 " + "filler ".repeat(MAX_DOCUMENT_CHARS / 3) + " 26.30 December 30, 2026" };
    const provider = new MockAiProvider("mock", scriptedResponder({
        extract: { items: [
            { kind: "version", label: "Patch 26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "", quote: "26.19 September 23, 2026" }] },
            { kind: "version", label: "Patch 26.30", identity: "26.30", status: "scheduled", fields: [{ field: "at", value: "2026-12-30", timezone: "", quote: "26.30 December 30, 2026" }] }
        ] }
    }));
    const result = await extractFacts(provider, topic, long);
    assert.equal(result.truncated, true);
    assert.ok(provider.requests[0].prompt.length < long.text.length);
    assert.equal(result.grounded.items.find(i => i.identity === "26.19")!.facts.length, 1);
    assert.equal(result.grounded.items.find(i => i.identity === "26.30")!.facts.length, 0, "a quote from the cut-off tail cannot be evidence");
});
