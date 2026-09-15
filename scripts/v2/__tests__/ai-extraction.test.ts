import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DOCUMENT_CHARS, classifyDocument, extractFacts, groundExtraction, identityOccursIn, mergeRepair, parseClassification, parseRawItems, quoteNamesIdentity, quoteOccursIn } from "../ai/extraction";
import { MockAiProvider, scriptedResponder } from "../ai/mock";
import { AiJsonRequest } from "../ai/provider";

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
    // Version tokens match whole: "6.19" is not contained in "26.19".
    assert.equal(identityOccursIn("6.19", text), false);
    assert.equal(quoteNamesIdentity("Patch 26.19 September 23, 2026", "6.19"), false);
    assert.equal(identityOccursIn("26.19", "Patch 26.19: notes."), true, "trailing punctuation does not break the token");
    assert.equal(identityOccursIn("Update 43.1", "Patch Notes - Update 43.1 Introducing Update 43.1:"), true);
    // Punctuation may differ, token boundaries may not: "September 2 3" is not "September 23".
    assert.equal(quoteOccursIn("Patch 26.19 releases September 23, 2026", "Patch 26.19 releases September 23 2026!"), true);
    assert.equal(quoteOccursIn("Patch 26.19 releases September 2 3, 2026", "Patch 26.19 releases September 23, 2026"), false);
    assert.equal(quoteOccursIn("Patch 26.19 releases September 23, 2026", "Patch 2 6.19 releases September 23, 2026"), false);
});

test("inverted or misordered start/end windows are rejected as a pair", () => {
    const text = "Live Maintenance Schedule (UTC). PC: March 11, 00:00 - 08:30. Console: March 19, 01:00 - 09:00. Posted 2026.03.10";
    const raw = parseRawItems({ items: [
        { kind: "occurrence", label: "PC", identity: "PC maintenance March 11", status: "ended", fields: [
            { field: "startAt", value: "2026-03-11T08:30", timezone: "UTC", quote: "PC: March 11, 00:00 - 08:30" },
            { field: "endAt", value: "2026-03-11T00:00", timezone: "UTC", quote: "PC: March 11, 00:00 - 08:30" }
        ] },
        { kind: "occurrence", label: "Console", identity: "Console maintenance March 19", status: "ended", fields: [
            { field: "startAt", value: "2026-03-19T01:00", timezone: "UTC", quote: "Console: March 19, 01:00 - 09:00" },
            { field: "endAt", value: "2026-03-19T09:00", timezone: "UTC", quote: "Console: March 19, 01:00 - 09:00" }
        ] }
    ] });
    const grounded = groundExtraction(raw, text, { now: new Date("2026-09-14T21:30:00Z") });
    assert.equal(grounded.items[0].facts.length, 0);
    assert.equal(grounded.rejected.filter(r => /inverted or read out of order/.test(r.reason)).length, 2);
    assert.deepEqual(grounded.items[1].facts.map(f => f.at), ["2026-03-19T01:00:00.000Z", "2026-03-19T09:00:00.000Z"]);
    assert.equal(grounded.stats.accepted, 2);
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
    assert.deepEqual(grounded.stats, { fields: 10, accepted: 3, rejected: 7, itemsDropped: 0, itemsRejected: 3 });
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
    assert.match(facts[2].note ?? "", /not "KST"/);
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

test("a quote listing several entries cannot lend one entry's time or zone to another", () => {
    const text = "Patch 26.19 schedule. PC: patch 26.19 releases September 23 at 15:00 PT; Console: patch 26.19 releases September 24 at 18:00 ET. Posted 2026.";
    const quote = "PC: patch 26.19 releases September 23 at 15:00 PT; Console: patch 26.19 releases September 24 at 18:00 ET";
    const now = new Date("2026-09-14T21:30:00Z");
    const raw = parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [
        { field: "at", value: "2026-09-23T18:00", timezone: "ET", quote },    // console's time and zone on the PC date
        { field: "startAt", value: "2026-09-23T15:00", timezone: "ET", quote }, // PC time, console's zone
        { field: "endAt", value: "2026-09-24T18:00", timezone: "ET", quote }    // console entry, consistent
    ] }] });
    const grounded = groundExtraction(raw, text, { now });
    const facts = grounded.items[0].facts;
    assert.deepEqual(facts.map(f => [f.field, f.precision, f.at]), [
        ["at", "day", "2026-09-23T00:00:00.000Z"],
        ["startAt", "day", "2026-09-23T00:00:00.000Z"],
        ["endAt", "exact", "2026-09-24T22:00:00.000Z"]
    ]);
    assert.match(facts[0].note ?? "", /next to the date/);
    assert.match(facts[1].note ?? "", /states America\/Los_Angeles next to this date/);

    // The PC entry with its own time and zone is exact.
    const pc = groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [
        { field: "at", value: "2026-09-23T15:00", timezone: "PT", quote }
    ] }] }), text, { now });
    assert.deepEqual(pc.items[0].facts.map(f => [f.precision, f.at, f.timezone]), [["exact", "2026-09-23T22:00:00.000Z", "America/Los_Angeles"]]);

    // "PDT" next to the date agrees with a claimed "PT" (same offset on that day), so the fact stays exact.
    const pdt = groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [
        { field: "at", value: "2026-09-23T15:00", timezone: "PT", quote: "Patch 26.19 releases September 23 at 15:00 PDT" }
    ] }] }), "Patch 26.19 releases September 23 at 15:00 PDT. Posted 2026.", { now });
    assert.equal(pdt.items[0].facts[0].precision, "exact");

    // A zone stated in a header applies when the quote itself names none.
    const header = groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [
        { field: "at", value: "2026-09-23T15:00", timezone: "PT", quote: "Patch 26.19 releases September 23 at 15:00" }
    ] }] }), "All times are in Pacific Time (PT). Patch 26.19 releases September 23 at 15:00. Posted 2026.", { now });
    assert.equal(header.items[0].facts[0].precision, "exact");
});

test("same-day entries bind time and zone to the entry that names the item; other zones in the document do not apply", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Maintenance for patch 26.19. PC maintenance September 23 at 15:00 PT; Console maintenance September 23 at 18:00 ET. Posted 2026.";
    const quote = "PC maintenance September 23 at 15:00 PT; Console maintenance September 23 at 18:00 ET";
    const items = (fields: Array<{ identity: string; value: string; timezone: string }>) => parseRawItems({ items: fields.map(f => ({ kind: "occurrence", label: f.identity, identity: f.identity, status: "scheduled", fields: [{ field: "at", value: f.value, timezone: f.timezone, quote }] })) });
    const grounded = groundExtraction(items([
        { identity: "Console maintenance September 23", value: "2026-09-23T15:00", timezone: "PT" },  // PC's time on the console item
        { identity: "Console maintenance September 23", value: "2026-09-23T18:00", timezone: "ET" },  // console's own entry
        { identity: "PC maintenance September 23", value: "2026-09-23T15:00", timezone: "PT" }
    ]), text, { now });
    assert.deepEqual(grounded.items.map(i => i.facts.map(f => [f.precision, f.at])), [
        [["day", "2026-09-23T00:00:00.000Z"]],
        [["exact", "2026-09-23T22:00:00.000Z"]],
        [["exact", "2026-09-23T22:00:00.000Z"]]
    ]);
    assert.match(grounded.items[0].facts[0].note ?? "", /next to the date/);

    // An item that neither entry clearly names cannot borrow a time.
    const vague = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "Maintenance", identity: "Maintenance September 23", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "PT", quote }] }] }), text, { now });
    assert.equal(vague.items[0].facts[0].precision, "day");
    assert.match(vague.items[0].facts[0].note ?? "", /several entries in the quote share this date/);

    // A zone the document states for something else ("support hours") is not evidence for a dated event.
    const support = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "PC", identity: "PC maintenance September 23", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "PT", quote: "PC maintenance September 23 at 15:00" }] }] }),
        "PC maintenance September 23 at 15:00. Support hours are PT. Posted 2026.", { now });
    assert.equal(support.items[0].facts[0].precision, "day");
    assert.match(support.items[0].facts[0].note ?? "", /not declared for times/);
    const declared = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "PC", identity: "PC maintenance September 23", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "PT", quote: "PC maintenance September 23 at 15:00" }] }] }),
        "All maintenance times are in PT. PC maintenance September 23 at 15:00. Posted 2026.", { now });
    assert.equal(declared.items[0].facts[0].precision, "exact");

    // A zone in the quote's header applies only when the header declares it for times, not for support hours.
    const hoursQuote = "Support hours are PT. PC maintenance September 23, 2026 at 15:00";
    const hours = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "PC", identity: "PC maintenance September 23", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "PT", quote: hoursQuote }] }] }),
        `${hoursQuote}. Posted 2026.`, { now });
    assert.equal(hours.items[0].facts[0].precision, "day");
    const scheduleQuote = "Live Maintenance Schedule (PT) ※ PC maintenance September 23, 2026 at 15:00";
    const schedule = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "PC", identity: "PC maintenance September 23", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00", timezone: "PT", quote: scheduleQuote }] }] }),
        `${scheduleQuote}. Posted 2026.`, { now });
    assert.equal(schedule.items[0].facts[0].precision, "exact");

    // Seconds the quote does not state are not accepted as exact.
    const seconds = groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T15:00:59", timezone: "PT", quote: "Patch 26.19 releases September 23 at 15:00 PT" }] }] }), "Patch 26.19 releases September 23 at 15:00 PT. Posted 2026.", { now });
    assert.equal(seconds.items[0].facts[0].precision, "day");
});

test("quotes that are not verbatim trigger one repair call, and the repaired answer wins only when it evidences more", async () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const doc = { url: "https://example.test/minecraft", title: "Minecraft: Bedrock Edition 26.44/45 Hotfix Changelog", text: "Minecraft: Bedrock Edition 26.44/45 Hotfix Changelog Update: 20 August 2026 26.45 Hotfix Please note, we have some additional fixes. Posted: 14 August 2026 A new hotfix is rolling out." };
    const topic = { game: "minecraft", gameName: "Minecraft", type: "last-release", description: "the latest Bedrock release" };
    const stitched = { items: [{ kind: "version", label: "26.45 Hotfix", identity: "26.45 Hotfix", status: "released", fields: [{ field: "at", value: "2026-08-20", timezone: "", quote: "26.45 Hotfix\n\nUpdate: 20 August 2026" }] }] };
    const verbatim = { items: [{ kind: "version", label: "26.45 Hotfix", identity: "26.45 Hotfix", status: "released", fields: [{ field: "at", value: "2026-08-20", timezone: "", quote: "Update: 20 August 2026 26.45 Hotfix" }] }] };
    const provider = new MockAiProvider("mock-model", scriptedResponder({ extract: stitched, "extract-repair": verbatim }));

    const result = await extractFacts(provider, topic, doc, { now });
    assert.equal(result.attempts, 2);
    assert.equal(result.repaired, true);
    assert.equal(provider.requests[1].label, "extract-repair");
    assert.match(provider.requests[1].prompt, /CORRECTIONS NEEDED[\s\S]*26\.45 Hotfix/);
    assert.deepEqual(result.grounded.items[0].facts.map(f => f.at), ["2026-08-20T00:00:00.000Z"]);
    assert.equal(result.usage.inputTokens, 2000, "both calls are accounted");

    // A repair that is no better is discarded, and a verbatim first answer needs no repair.
    const stubborn = new MockAiProvider("mock-model", scriptedResponder({ extract: stitched, "extract-repair": stitched }));
    const same = await extractFacts(stubborn, topic, doc, { now });
    assert.equal(same.attempts, 2);
    assert.equal(same.repaired, false);
    assert.equal(same.grounded.items[0].facts.length, 0);
    const fine = new MockAiProvider("mock-model", scriptedResponder({ extract: verbatim }));
    const once = await extractFacts(fine, topic, doc, { now });
    assert.equal(once.attempts, 1);
    assert.equal(once.repaired, false);
    const off = await extractFacts(new MockAiProvider("mock-model", scriptedResponder({ extract: stitched })), topic, doc, { now, repair: false });
    assert.equal(off.attempts, 1);

    // A repair call that fails (say, MAX_TOKENS) never costs the first answer.
    const crashing = new MockAiProvider("mock-model", (req: AiJsonRequest) => req.label === "extract" ? verbatim : new Error("Gemini stopped with finishReason MAX_TOKENS"));
    const partial = await extractFacts(crashing, topic, { ...doc, text: doc.text }, { now });
    assert.equal(partial.attempts, 1, "a verbatim first answer needs no repair");
    const broken = new MockAiProvider("mock-model", (req: AiJsonRequest) => req.label === "extract" ? stitched : new Error("Gemini stopped with finishReason MAX_TOKENS"));
    const survived = await extractFacts(broken, topic, doc, { now });
    assert.equal(survived.attempts, 2);
    assert.equal(survived.repaired, false);
    assert.match(survived.repairError ?? "", /MAX_TOKENS/);
    assert.equal(survived.grounded.items[0].facts.length, 0, "the first answer (with its rejection) stands");
});

test("a repair only fills the gaps the first answer left; grounded facts are never replaced", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Maintenance for 26.19. PC: September 23, 15:00 - 18:00 UTC. All times UTC. Posted 2026.";
    const first = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "PC", identity: "PC maintenance September 23", status: "scheduled", fields: [
        { field: "startAt", value: "2026-09-23T15:00", timezone: "UTC", quote: "PC: September 23, 15:00 - 18:00 UTC" },
        { field: "endAt", value: "2026-09-23T18:00", timezone: "UTC", quote: "PC ends September 23 at 18:00 UTC" }   // paraphrased: unverifiable
    ] }] }), text, { now });
    assert.deepEqual(first.items[0].facts.map(f => f.field), ["startAt"]);
    assert.equal(first.rejected[0].reason, "quote not found in document");

    // The repair answers with a day-only start (worse) and a verbatim end (the gap).
    const repair = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "PC", identity: "PC maintenance September 23", status: "scheduled", fields: [
        { field: "startAt", value: "2026-09-23", timezone: "", quote: "PC: September 23, 15:00 - 18:00 UTC" },
        { field: "endAt", value: "2026-09-23T18:00", timezone: "UTC", quote: "PC: September 23, 15:00 - 18:00 UTC" }
    ] }, { kind: "occurrence", label: "Console", identity: "Console maintenance September 24", status: "scheduled", fields: [] }] }), text, { now });
    const { merged, filled } = mergeRepair(first, repair);
    assert.equal(filled, 1);
    assert.deepEqual(merged.items.map(i => i.identity), ["PC maintenance September 23"], "items the repair invents are ignored");
    assert.deepEqual(merged.items[0].facts.map(f => [f.field, f.precision, f.at]), [["startAt", "exact", "2026-09-23T15:00:00.000Z"], ["endAt", "exact", "2026-09-23T18:00:00.000Z"]]);
    assert.equal(merged.rejected.length, 0);
    assert.equal(merged.stats.accepted, 2);

    // A filled bound that contradicts the accepted one is dropped again.
    const inverted = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "PC", identity: "PC maintenance September 23", status: "scheduled", fields: [
        { field: "endAt", value: "2026-09-22", timezone: "", quote: "Maintenance for 26.19. PC: September 22" }
    ] }] }), "Maintenance for 26.19. PC: September 22, then PC: September 23, 15:00 - 18:00 UTC. All times UTC. Posted 2026.", { now });
    const bad = mergeRepair(first, inverted);
    assert.equal(bad.filled, 0);
    assert.deepEqual(bad.merged.items[0].facts.map(f => f.field), ["startAt"]);
    assert.ok(bad.merged.rejected.some(r => /inverted/.test(r.reason)));
});

test("a window with an exact start and a day-only end is not inverted", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Maintenance for 26.19 starts September 23 at 15:00 PT and ends September 23. All times are in PT. Posted 2026.";
    const grounded = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "Maintenance", identity: "Maintenance September 23", status: "scheduled", fields: [
        { field: "startAt", value: "2026-09-23T15:00", timezone: "PT", quote: "Maintenance for 26.19 starts September 23 at 15:00 PT" },
        { field: "endAt", value: "2026-09-23", timezone: "", quote: "Maintenance for 26.19 starts September 23 at 15:00 PT and ends September 23" }
    ] }] }), text, { now });
    assert.deepEqual(grounded.items[0].facts.map(f => [f.field, f.precision]), [["startAt", "exact"], ["endAt", "day"]]);
    assert.equal(grounded.rejected.length, 0);
});

test("a date is evidence only inside the entry that names the item, even when it is the only dated entry", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Maintenance. PC maintenance is September 23, 2026 at 15:00 PT; Console maintenance date is TBD. All times PT.";
    const quote = "PC maintenance is September 23, 2026 at 15:00 PT; Console maintenance date is TBD";
    const run = (identity: string, value: string) => groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: identity, identity, status: "scheduled", fields: [{ field: "at", value, timezone: "PT", quote }] }] }), text, { now });
    const console_ = run("Console maintenance September 23", "2026-09-23T15:00");
    assert.equal(console_.items[0].facts.length, 0);
    assert.match(console_.rejected[0].reason, /belongs to another entry/);
    assert.equal(run("Console maintenance September 23", "2026-09-23").items[0].facts.length, 0, "day-only facts are bound too");
    const pc = run("PC maintenance September 23", "2026-09-23T15:00");
    assert.deepEqual(pc.items[0].facts.map(f => [f.precision, f.at]), [["exact", "2026-09-23T22:00:00.000Z"]]);

    // Every field of a rejected item is reported, so fields == accepted + rejected.
    const bogus = groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: "Mobile", identity: "Mobile maintenance", status: "scheduled", fields: [
        { field: "startAt", value: "2026-09-23T15:00", timezone: "PT", quote },
        { field: "endAt", value: "2026-09-23T18:00", timezone: "PT", quote }
    ] }, { kind: "occurrence", label: "Nothing", identity: "Nothing here", status: "unknown", fields: [] }] }), text, { now });
    assert.equal(bogus.stats.fields, 2);
    assert.equal(bogus.stats.rejected, 2);
    assert.equal(bogus.stats.accepted, 0);
    assert.equal(bogus.stats.itemsRejected, 2);
    assert.deepEqual(bogus.rejected.map(r => [r.identity, r.field]), [["Mobile maintenance", "startAt"], ["Mobile maintenance", "endAt"], ["Nothing here", "at"]]);
});

test("a row with several clock/zone pairs lends a clock only its own zone", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Patch 26.19 releases September 23 at 15:00 PT / 18:00 ET. Posted 2026.";
    const quote = "Patch 26.19 releases September 23 at 15:00 PT / 18:00 ET";
    const run = (value: string, timezone: string) => groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value, timezone, quote }] }] }), text, { now }).items[0].facts[0];
    const wrong = run("2026-09-23T18:00", "PT");
    assert.equal(wrong.precision, "day");
    assert.match(wrong.note ?? "", /stated in America\/New_York, not "PT"/);
    assert.deepEqual([run("2026-09-23T15:00", "PT").at, run("2026-09-23T18:00", "ET").at], ["2026-09-23T22:00:00.000Z", "2026-09-23T22:00:00.000Z"]);
    const unpaired = groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value: "2026-09-23T18:00", timezone: "ET", quote: "Patch 26.19 releases September 23 at 15:00 PT, 18:00 (ET server), 21:00" }] }] }),
        "Patch 26.19 releases September 23 at 15:00 PT, 18:00 (ET server), 21:00. Posted 2026.", { now }).items[0].facts[0];
    assert.equal(unpaired.precision, "exact", "a zone right after the clock, even in parentheses, is its zone");
});

test("one value per item and field: identical repeats collapse, conflicts reject both", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Patch 26.19 was posted September 22, 2026. Patch 26.19 releases September 23, 2026. Patch 26.20 releases October 7, 2026. Posted 2026.";
    const item = (fields: any[]) => ({ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields });
    const conflict = groundExtraction(parseRawItems({ items: [item([
        { field: "at", value: "2026-09-22", timezone: "", quote: "Patch 26.19 was posted September 22, 2026" },
        { field: "at", value: "2026-09-23", timezone: "", quote: "Patch 26.19 releases September 23, 2026" }
    ])] }), text, { now });
    assert.equal(conflict.items[0].facts.length, 0);
    assert.deepEqual(conflict.rejected.map(r => [r.value, r.reason]), [["2026-09-22", "conflicting values for the same field"], ["2026-09-23", "conflicting values for the same field"]]);
    assert.deepEqual([conflict.stats.fields, conflict.stats.accepted, conflict.stats.rejected], [2, 0, 2]);

    const repeat = groundExtraction(parseRawItems({ items: [item([
        { field: "at", value: "2026-09-23", timezone: "", quote: "Patch 26.19 releases September 23, 2026" },
        { field: "at", value: "2026-09-23", timezone: "", quote: "Patch 26.19 releases September 23, 2026. Patch 26.20" }
    ])] }), text, { now });
    assert.equal(repeat.items[0].facts.length, 1);
    assert.deepEqual([repeat.stats.fields, repeat.stats.accepted, repeat.stats.rejected], [1, 1, 0], "an identical repeat is not a second field");
});

test("a label that belongs to the next dated entry cannot claim the previous entry's date and time", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Maintenance for 26.19: PC maintenance September 23 at 15:00 PT, Console maintenance September 24 at 18:00 ET. Posted 2026.";
    const quote = "PC maintenance September 23 at 15:00 PT, Console maintenance September 24 at 18:00 ET";
    const run = (identity: string, value: string, timezone: string) => groundExtraction(parseRawItems({ items: [{ kind: "occurrence", label: identity, identity, status: "scheduled", fields: [{ field: "at", value, timezone, quote }] }] }), text, { now });
    const stolen = run("Console maintenance September 23", "2026-09-23T15:00", "PT");
    assert.equal(stolen.items[0].facts.length, 0);
    assert.match(stolen.rejected[0].reason, /belongs to another entry/);
    assert.deepEqual(run("PC maintenance September 23", "2026-09-23T15:00", "PT").items[0].facts.map(f => [f.precision, f.at]), [["exact", "2026-09-23T22:00:00.000Z"]]);
    assert.deepEqual(run("Console maintenance September 24", "2026-09-24T18:00", "ET").items[0].facts.map(f => [f.precision, f.at]), [["exact", "2026-09-24T22:00:00.000Z"]]);
});

test("an embedded offset must be attached to the claimed clock, and a conflicted field stays rejected", () => {
    const now = new Date("2026-09-14T21:30:00Z");
    const text = "Patch 26.19 releases September 23 at 15:00+01:00 / 18:00+02:00. Posted 2026.";
    const quote = "Patch 26.19 releases September 23 at 15:00+01:00 / 18:00+02:00";
    const run = (value: string) => groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [{ field: "at", value, timezone: "", quote }] }] }), text, { now }).items[0].facts[0];
    assert.equal(run("2026-09-23T18:00+01:00").precision, "day", "+01:00 belongs to 15:00");
    assert.equal(run("2026-09-23T15:00+01:00").at, "2026-09-23T14:00:00.000Z");
    assert.equal(run("2026-09-23T18:00+02:00").at, "2026-09-23T16:00:00.000Z");

    const three = groundExtraction(parseRawItems({ items: [{ kind: "version", label: "26.19", identity: "26.19", status: "scheduled", fields: [
        { field: "at", value: "2026-09-22", timezone: "", quote: "Patch 26.19 was posted September 22, 2026" },
        { field: "at", value: "2026-09-23", timezone: "", quote: "Patch 26.19 releases September 23, 2026" },
        { field: "at", value: "2026-09-24", timezone: "", quote: "Patch 26.19 lands September 24, 2026" }
    ] }] }), "Patch 26.19 was posted September 22, 2026. Patch 26.19 releases September 23, 2026. Patch 26.19 lands September 24, 2026. Posted 2026.", { now });
    assert.equal(three.items[0].facts.length, 0, "a third value does not sneak in after the conflict");
    assert.deepEqual([three.stats.fields, three.stats.accepted, three.stats.rejected], [3, 0, 3]);
    assert.ok(three.rejected.every(r => r.reason === "conflicting values for the same field"));
});
