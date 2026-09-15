import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DOCUMENT_CHARS, classifyDocument, extractFacts, groundExtraction, identityOccursIn, parseClassification, parseRawItems, quoteNamesIdentity, quoteOccursIn } from "../ai/extraction";
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

test("identities must occur in the document and quotes must name their item", () => {
    const text = "Live Maintenance Schedule (UTC) ※ PC: March 11, 00:00 - 08:30. September 10, 2026 Counter-Strike 2 Update [ MAPS ] Cache. Patch 26.19 September 23, 2026.";
    assert.equal(identityOccursIn("26.19", text), true);
    assert.equal(identityOccursIn("Live Maintenance PC March 11", text), true, "all significant tokens occur");
    assert.equal(identityOccursIn("Counter-Strike 2 Update September 10, 2026", text), true);
    assert.equal(identityOccursIn("99.99", text), false);
    assert.equal(identityOccursIn("Live Maintenance Xbox", text), false);
    assert.equal(quoteNamesIdentity("September 10, 2026 Counter-Strike 2 Update", "Counter-Strike 2 Update September 10, 2026"), true);
    assert.equal(quoteNamesIdentity("PC: March 11, 00:00 - 08:30", "Live Maintenance PC March 11"), true);
    assert.equal(quoteNamesIdentity("26.19 September 23, 2026", "26.19"), true);
    assert.equal(quoteNamesIdentity("Posted: 14 August 2026", "26.44"), false);
    assert.equal(quoteNamesIdentity("26.19 September 23, 2026", "99.99"), false);
    // The shared date is not an association: the discriminating word must be in the quote.
    assert.equal(quoteNamesIdentity("Console maintenance is March 11, 2026", "PC maintenance March 11"), false);
    assert.equal(quoteNamesIdentity("PC maintenance is March 11, 2026", "PC maintenance March 11"), true);
    assert.equal(quoteNamesIdentity("Call of Duty: Warzone Season 04 Reloaded Patch Notes July 15, 2026", "Season 04 Reloaded"), true);
    assert.equal(quoteNamesIdentity("Call of Duty: Warzone Season 04 Patch Notes June 16, 2026", "Season 04 Reloaded"), false);
});

test("inferred years and embedded offsets must be supported by evidence", () => {
    const text = "Date Posted Sep 12, 2026. Genshin Impact Version 7.1 launches on September 23! Patch 26.19 releases September 23, 2026 at 3 PM PT. Listing 2026-09-09T18:00:00.000Z League of Legends Patch 26.18 Notes.";
    const raw = parseRawItems({ items: [
        { kind: "version", label: "Version 7.1 ok", identity: "Version 7.1", status: "scheduled", fields: [{ field: "startAt", value: "2026-09-23", timezone: "", quote: "Version 7.1 launches on September 23!" }] },
        { kind: "version", label: "Version 7.1 wrong year", identity: "Version 7.1", status: "scheduled", fields: [{ field: "startAt", value: "2099-09-23", timezone: "", quote: "Version 7.1 launches on September 23!" }] },
        { kind: "version", label: "26.19 fake offset", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00+14:00", timezone: "PT", quote: "Patch 26.19 releases September 23, 2026 at 3 PM PT" }] },
        { kind: "version", label: "26.19 stated zone offset", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00-07:00", timezone: "PT", quote: "Patch 26.19 releases September 23, 2026 at 3 PM PT" }] },
        { kind: "version", label: "26.18 ISO Z", identity: "26.18", status: "released", fields: [{ field: "at", value: "2026-09-09T18:00Z", timezone: "", quote: "2026-09-09T18:00:00.000Z League of Legends Patch 26.18 Notes" }] }
    ] });
    const grounded = groundExtraction(raw, text, { now: new Date("2026-09-14T21:30:00Z") });
    const byLabel = Object.fromEntries(grounded.items.map(i => [i.label, i]));
    assert.equal(byLabel["Version 7.1 ok"].facts[0].yearInferred, true);
    assert.equal(byLabel["Version 7.1 wrong year"].facts.length, 0);
    assert.ok(grounded.rejected.some(r => /inferred year 2099/.test(r.reason)));
    assert.deepEqual([byLabel["26.19 fake offset"].facts[0].at, byLabel["26.19 fake offset"].facts[0].precision], ["2026-09-23T00:00:00.000Z", "day"]);
    assert.match(byLabel["26.19 fake offset"].facts[0].note ?? "", /embedded UTC offset/);
    assert.deepEqual([byLabel["26.19 stated zone offset"].facts[0].at, byLabel["26.19 stated zone offset"].facts[0].precision], ["2026-09-23T22:00:00.000Z", "exact"]);
    assert.deepEqual([byLabel["26.18 ISO Z"].facts[0].at, byLabel["26.18 ISO Z"].facts[0].precision], ["2026-09-09T18:00:00.000Z", "exact"]);

    // Next year is plausible for an announced date; two years out is not.
    const nextYear = groundExtraction(parseRawItems({ items: [
        { kind: "version", label: "next", identity: "Version 7.1", status: "scheduled", fields: [{ field: "startAt", value: "2027-09-23", timezone: "", quote: "Version 7.1 launches on September 23!" }] },
        { kind: "version", label: "far", identity: "Version 7.1", status: "scheduled", fields: [{ field: "startAt", value: "2028-09-23", timezone: "", quote: "Version 7.1 launches on September 23!" }] }
    ] }), text, { now: new Date("2026-09-14T21:30:00Z") });
    assert.equal(nextYear.items[0].facts.length, 1);
    assert.equal(nextYear.items[1].facts.length, 0);
});

test("groundExtraction accepts supported facts and rejects unsupported ones with reasons", () => {
    const raw = parseRawItems({
        items: [
            { kind: "version", label: "Patch 26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "Pacific Time", quote: "26.19 September 23, 2026" }] },
            { kind: "version", label: "Patch 26.25", identity: "26.25", status: "scheduled", fields: [{ field: "at", value: "2026-12-23", timezone: "PT", quote: "26.25 December 23, 2026" }] },
            { kind: "version", label: "Patch 26.20", identity: "26.20", status: "scheduled", fields: [{ field: "at", value: "2026-10-08", timezone: "PT", quote: "26.20 October 7, 2026" }] },
            { kind: "version", label: "Patch 26.18", identity: "26.18", status: "released", fields: [{ field: "at", value: "2025-09-10", timezone: "PT", quote: "26.18 September 10, 2026 (Thursday)" }] },
            { kind: "period", label: "Version 7.1", identity: "Version 7.1", status: "scheduled", fields: [{ field: "startAt", value: "2026-09-23", timezone: "", quote: "Version 7.1 \"A Rekviem\" launches on September 23!" }] },
            { kind: "version", label: "Bad value", identity: "26.21", status: "scheduled", fields: [{ field: "at", value: "October 21", timezone: "", quote: "26.21 October 21, 2026" }] },
            { kind: "version", label: "No quote", identity: "26.22", status: "scheduled", fields: [{ field: "at", value: "2026-11-04", timezone: "", quote: "" }] },
            { kind: "version", label: "Timed but time not quoted", identity: "26.23", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "Pacific Time", quote: "26.23 September 23, 2026" }] },
            { kind: "version", label: "Bad identity", identity: "!!!", status: "unknown", fields: [] },
            { kind: "version", label: "Fabricated identity with a real quote", identity: "99.99", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "PT", quote: "26.19 September 23, 2026" }] },
            { kind: "version", label: "Real identity, unrelated quote", identity: "26.24", status: "scheduled", fields: [{ field: "at", value: "2026-09-23", timezone: "PT", quote: "26.19 September 23, 2026" }] }
        ]
    });
    const grounded = groundExtraction(raw, doc.text + " 26.21 October 21, 2026 26.22 November 4, 2026 26.23 September 23, 2026 26.24 December 9, 2026");

    const byIdentity = Object.fromEntries(grounded.items.map(i => [i.identity, i]));
    assert.deepEqual(byIdentity["26.19"].facts.map(f => [f.field, f.at, f.precision, f.timezone, f.yearInferred]), [["at", "2026-09-23T00:00:00.000Z", "day", "America/Los_Angeles", false]]);
    assert.equal("26.25" in byIdentity, false, "a patch number the document never mentions is rejected as an item");
    assert.equal(byIdentity["26.20"].facts.length, 0);
    assert.equal(byIdentity["26.18"].facts.length, 0);
    assert.deepEqual(byIdentity["Version 7.1"].facts.map(f => [f.field, f.at, f.precision, f.yearInferred]), [["startAt", "2026-09-23T00:00:00.000Z", "day", true]]);
    assert.equal(byIdentity["Version 7.1"].identityKey, "version-7.1");
    assert.equal(byIdentity["26.21"].facts.length, 0);
    assert.equal(byIdentity["26.22"].facts.length, 0);
    // The quote states the day but not the 15:00 time: kept at day precision, not a made-up instant.
    assert.deepEqual(byIdentity["26.23"].facts.map(f => [f.at, f.precision]), [["2026-09-23T00:00:00.000Z", "day"]]);
    assert.match(byIdentity["26.23"].facts[0].note ?? "", /clock time/);
    assert.equal("!!!" in byIdentity, false);
    assert.equal("99.99" in byIdentity, false, "an identity absent from the document is rejected outright");
    assert.equal(byIdentity["26.24"].facts.length, 0, "a quote about another item is not evidence");

    const reasons = Object.fromEntries(grounded.rejected.map(r => [`${r.identity}`, r.reason]));
    assert.match(reasons["26.25"], /identity not found in document/);
    assert.match(reasons["26.20"], /does not mention the claimed day/);
    assert.match(reasons["26.18"], /different year/);
    assert.match(reasons["26.21"], /not an ISO date/);
    assert.match(reasons["26.22"], /quote missing/);
    assert.match(reasons["!!!"], /identity cannot be normalized/);
    assert.match(reasons["99.99"], /identity not found in document/);
    assert.match(reasons["26.24"], /does not mention the item/);
    assert.deepEqual(grounded.stats, { fields: 10, accepted: 3, rejected: 8, itemsDropped: 0, itemsRejected: 3 });
});

test("exact instants need the time and the zone to be stated; otherwise the day is kept", () => {
    const text = "Live Maintenance Schedule (UTC). PC: March 11, 00:00 - 08:30. Patch 26.19 releases September 23, 2026 at 3 PM PT. Patch 26.20 releases October 7 at 15:00.";
    const raw = parseRawItems({ items: [
        { kind: "occurrence", label: "PC maintenance", identity: "PC maintenance March 11", status: "ended", fields: [{ field: "startAt", value: "2026-03-11T00:00", timezone: "UTC", quote: "PC: March 11, 00:00 - 08:30" }] },
        { kind: "version", label: "Patch 26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "PT", quote: "Patch 26.19 releases September 23, 2026 at 3 PM PT" }] },
        { kind: "version", label: "Patch 26.19 wrong zone", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "KST", quote: "Patch 26.19 releases September 23, 2026 at 3 PM PT" }] },
        { kind: "version", label: "Patch 26.20", identity: "26.20", status: "scheduled", fields: [{ field: "at", value: "2026-10-07T15:00", timezone: "", quote: "Patch 26.20 releases October 7 at 15:00" }] }
    ] });
    const grounded = groundExtraction(raw, text);
    const facts = grounded.items.map(i => i.facts[0]);
    assert.deepEqual([facts[0].at, facts[0].precision, facts[0].timezone, facts[0].yearInferred], ["2026-03-11T00:00:00.000Z", "exact", "UTC", true]);
    assert.deepEqual([facts[1].at, facts[1].precision, facts[1].timezone], ["2026-09-23T22:00:00.000Z", "exact", "America/Los_Angeles"]);
    assert.deepEqual([facts[2].at, facts[2].precision], ["2026-09-23T00:00:00.000Z", "day"]);
    assert.match(facts[2].note ?? "", /timezone "KST" not stated/);
    assert.deepEqual([facts[3].at, facts[3].precision], ["2026-10-07T00:00:00.000Z", "day"]);
    assert.match(facts[3].note ?? "", /without a timezone/);
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
    assert.equal(result.grounded.items.some(i => i.identity === "26.30"), false, "an item from the cut-off tail cannot be grounded");
    assert.ok(result.grounded.rejected.some(r => r.identity === "26.30" && /identity not found/.test(r.reason)));
});
