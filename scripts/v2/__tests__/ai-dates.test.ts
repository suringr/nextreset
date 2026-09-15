import test from "node:test";
import assert from "node:assert/strict";
import { clockTimesIn, dateSegment, dateSegments, normalizeDateFact, parseDateValue, quoteMentionsDate, quoteMentionsTime, resolveTimezone, zoneAfterClock, zoneDeclaredIn, zonedToUtc, zonedToUtcDetailed, zonesIn } from "../ai/dates";

test("parseDateValue accepts ISO dates and local date-times, rejects everything else", () => {
    assert.deepEqual(parseDateValue("2026-09-23"), { year: 2026, month: 9, day: 23, hasTime: false });
    assert.deepEqual(parseDateValue("2026-09-23T18:00"), { year: 2026, month: 9, day: 23, hour: 18, minute: 0, second: 0, hasTime: true });
    assert.equal(parseDateValue("2026-09-09T18:00:00.000Z"), undefined, "milliseconds are not part of the contract");
    assert.equal(parseDateValue("2026-09-09T18:00Z")?.offsetMinutes, 0);
    assert.equal(parseDateValue("2026-09-09T18:00+08:00")?.offsetMinutes, 480);
    assert.equal(parseDateValue("September 23, 2026"), undefined);
    assert.equal(parseDateValue("2026-02-30"), undefined);
    assert.equal(parseDateValue("2026-13-01"), undefined);
    assert.equal(parseDateValue("2026-09-23Z"), undefined);
});

test("timezone phrases resolve to IANA zones or fixed offsets; ambiguous ones do not", () => {
    assert.deepEqual(resolveTimezone("PT"), { zone: "America/Los_Angeles", kind: "iana" });
    assert.deepEqual(resolveTimezone("Pacific Time"), { zone: "America/Los_Angeles", kind: "iana" });
    assert.deepEqual(resolveTimezone("(PT)"), { zone: "America/Los_Angeles", kind: "iana" });
    // Explicit standard/daylight abbreviations are fixed offsets, whatever the date.
    assert.deepEqual(resolveTimezone("PST"), { zone: "-08:00", kind: "offset" });
    assert.deepEqual(resolveTimezone("PDT"), { zone: "-07:00", kind: "offset" });
    assert.deepEqual(resolveTimezone("EST"), { zone: "-05:00", kind: "offset" });
    assert.deepEqual(resolveTimezone("EDT"), { zone: "-04:00", kind: "offset" });
    assert.deepEqual(resolveTimezone("KST"), { zone: "+09:00", kind: "offset" });
    assert.equal(zonedToUtc(parseDateValue("2026-07-15T12:00")!, resolveTimezone("PST")!.zone)!.toISOString(), "2026-07-15T20:00:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-01-15T12:00")!, resolveTimezone("PDT")!.zone)!.toISOString(), "2026-01-15T19:00:00.000Z");
    assert.deepEqual(resolveTimezone("UTC"), { zone: "UTC", kind: "utc" });
    assert.deepEqual(resolveTimezone("UTC+8"), { zone: "+08:00", kind: "offset" });
    assert.deepEqual(resolveTimezone("GMT-5"), { zone: "-05:00", kind: "offset" });
    assert.deepEqual(resolveTimezone("UTC+0"), { zone: "UTC", kind: "utc" });
    assert.deepEqual(resolveTimezone("Asia/Seoul"), { zone: "Asia/Seoul", kind: "iana" });
    assert.equal(resolveTimezone("server time"), undefined);
    assert.equal(resolveTimezone("IST"), undefined, "ambiguous abbreviations stay unresolved");
    assert.equal(resolveTimezone(""), undefined);
    assert.equal(resolveTimezone(undefined), undefined);
});

test("zonedToUtc is DST-aware and handles fixed offsets", () => {
    const sept = parseDateValue("2026-09-23T15:00")!;
    assert.equal(zonedToUtc(sept, "America/Los_Angeles")!.toISOString(), "2026-09-23T22:00:00.000Z");
    const jan = parseDateValue("2026-01-08T15:00")!;
    assert.equal(zonedToUtc(jan, "America/Los_Angeles")!.toISOString(), "2026-01-08T23:00:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-09-23T04:00")!, "+08:00")!.toISOString(), "2026-09-22T20:00:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-09-23T04:00")!, "UTC")!.toISOString(), "2026-09-23T04:00:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-09-23T00:00")!, "Asia/Seoul")!.toISOString(), "2026-09-22T15:00:00.000Z");
    // The skipped hour of a spring-forward transition has no instant.
    assert.equal(zonedToUtc(parseDateValue("2026-03-08T02:30")!, "America/Los_Angeles"), undefined);
    assert.equal(zonedToUtc(parseDateValue("2026-03-08T03:30")!, "America/Los_Angeles")!.toISOString(), "2026-03-08T10:30:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-03-08T01:30")!, "America/Los_Angeles")!.toISOString(), "2026-03-08T09:30:00.000Z");
    // A repeated fall-back hour is ambiguous in a named zone; a fixed offset settles it.
    assert.equal(zonedToUtc(parseDateValue("2026-11-01T01:30")!, "America/Los_Angeles"), undefined);
    assert.equal(zonedToUtcDetailed(parseDateValue("2026-11-01T01:30")!, "America/Los_Angeles").problem, "ambiguous");
    assert.equal(zonedToUtcDetailed(parseDateValue("2026-03-08T02:30")!, "America/Los_Angeles").problem, "nonexistent");
    assert.equal(zonedToUtc(parseDateValue("2026-11-01T00:30")!, "America/Los_Angeles")!.toISOString(), "2026-11-01T07:30:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-11-01T02:30")!, "America/Los_Angeles")!.toISOString(), "2026-11-01T10:30:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-11-01T01:30")!, "-07:00")!.toISOString(), "2026-11-01T08:30:00.000Z");
    const overlap = normalizeDateFact("2026-11-01T01:30", "PT");
    assert.equal(overlap?.precision, "day");
    assert.match(overlap?.note ?? "", /occurs twice/);
    assert.equal(normalizeDateFact("2026-11-01T01:30", "PDT")?.at, "2026-11-01T08:30:00.000Z");
    const gap = normalizeDateFact("2026-03-08T02:30", "PT");
    assert.equal(gap?.precision, "day");
    assert.match(gap?.note ?? "", /does not exist/);
});

test("normalizeDateFact decides precision from what was stated", () => {
    assert.deepEqual(normalizeDateFact("2026-09-23", "PT"), { at: "2026-09-23T00:00:00.000Z", precision: "day", timezone: "America/Los_Angeles" });
    assert.deepEqual(normalizeDateFact("2026-09-23", ""), { at: "2026-09-23T00:00:00.000Z", precision: "day" });
    assert.deepEqual(normalizeDateFact("2026-09-23T15:00", "PT"), { at: "2026-09-23T22:00:00.000Z", precision: "exact", timezone: "America/Los_Angeles" });
    assert.deepEqual(normalizeDateFact("2026-09-09T18:00", "UTC"), { at: "2026-09-09T18:00:00.000Z", precision: "exact", timezone: "UTC" });
    assert.deepEqual(normalizeDateFact("2026-09-09T18:00Z", "whatever"), { at: "2026-09-09T18:00:00.000Z", precision: "exact", timezone: "UTC" });
    assert.deepEqual(normalizeDateFact("2026-03-11T00:00+08:00", ""), { at: "2026-03-10T16:00:00.000Z", precision: "exact", timezone: "+08:00" });

    const unknownZone = normalizeDateFact("2026-09-23T15:00", "server time");
    assert.equal(unknownZone?.precision, "day");
    assert.equal(unknownZone?.at, "2026-09-23T00:00:00.000Z");
    assert.match(unknownZone?.note ?? "", /not understood/);

    const noZone = normalizeDateFact("2026-09-23T15:00", "");
    assert.equal(noZone?.precision, "day");
    assert.match(noZone?.note ?? "", /without a timezone/);

    assert.equal(normalizeDateFact("not a date", ""), undefined);
});

test("quoteMentionsDate checks day, month and year against the quote", () => {
    const sept23 = parseDateValue("2026-09-23")!;
    assert.deepEqual(quoteMentionsDate("26.19 September 23, 2026", sept23), { day: true, month: true, year: true });
    assert.deepEqual(quoteMentionsDate("launches on September 23!", sept23), { day: true, month: true, year: null });
    assert.deepEqual(quoteMentionsDate("Sept. 23rd", sept23), { day: true, month: true, year: null });
    assert.deepEqual(quoteMentionsDate("26.19 September 23, 2025", sept23), { day: true, month: true, year: false });
    assert.deepEqual(quoteMentionsDate("26.20 October 7, 2026", sept23), { day: false, month: false, year: true });

    const sep9 = parseDateValue("2026-09-09")!;
    assert.deepEqual(quoteMentionsDate("PATCH NOTES 2026.09.09", sep9), { day: true, month: true, year: true });
    assert.deepEqual(quoteMentionsDate("2026-09-09T18:00:00.000Z League of Legends Patch 26.18 Notes", sep9), { day: true, month: true, year: true });
    assert.deepEqual(quoteMentionsDate("9/9 update", sep9), { day: true, month: true, year: null });

    const mar11 = parseDateValue("2026-03-11")!;
    assert.deepEqual(quoteMentionsDate("PC: March 11, 00:00 - 08:30", mar11), { day: true, month: true, year: null });
    assert.equal(quoteMentionsDate("PC: March 1, 00:00 - 08:30", mar11).day, false, "day 1 is not day 11");
    assert.equal(quoteMentionsDate("at 11:00 in March", mar11).day, false, "a clock hour is not a day");

    const aug20 = parseDateValue("2026-08-20")!;
    assert.deepEqual(quoteMentionsDate("Update: 20 August 2026 26.45 Hotfix", aug20), { day: true, month: true, year: true });

    // Version numbers never supply a day: "26.19" is neither the 26th nor the 19th.
    const sept26 = parseDateValue("2026-09-26")!;
    assert.equal(quoteMentionsDate("Patch 26.19 will release in September 2026", sept26).day, false);
    const sept19 = parseDateValue("2026-09-19")!;
    assert.equal(quoteMentionsDate("Patch 26.19 will release in September 2026", sept19).day, false);
    assert.equal(quoteMentionsDate("Patch 26.19 will release on September 19, 2026", sept19).day, true);
    const sept9b = parseDateValue("2026-09-09")!;
    assert.equal(quoteMentionsDate("Patch 26.9 notes", sept9b).day, false, "26.9 is a version, not September 9th");

    // Month, day and year must belong to one date expression; parts of different dates never combine.
    assert.equal(quoteMentionsDate("Patch 26.19 was posted September 9 and releases October 23, 2026", sept23).day, false);
    assert.deepEqual(quoteMentionsDate("Posted in 2026. Patch 26.19 launches September 23", sept23), { day: true, month: true, year: null }, "a year elsewhere in the quote is not attached to the mention");
    assert.deepEqual(quoteMentionsDate("Patch 26.19 launches September 23, 2025", sept23), { day: true, month: true, year: false });
    assert.deepEqual(quoteMentionsDate("September 23, 2025 was the plan; now September 23, 2026", sept23), { day: true, month: true, year: true });
    assert.deepEqual(quoteMentionsDate("23 September 2026", sept23), { day: true, month: true, year: true });
    assert.deepEqual(quoteMentionsDate("on the 23rd of September", sept23), { day: true, month: true, year: null });
    assert.deepEqual(quoteMentionsDate("23.09.2026 release", sept23), { day: true, month: true, year: true });
    assert.deepEqual(quoteMentionsDate("9/23/2026", sept23), { day: true, month: true, year: true });
    // Numeric dates are evidence only when they have a single valid reading.
    const sept10 = parseDateValue("2026-09-10")!;
    const oct9 = parseDateValue("2026-10-09")!;
    assert.equal(quoteMentionsDate("Update 9/10/2026", sept10).day, false, "9/10 could be October 9");
    assert.equal(quoteMentionsDate("Update 9/10/2026", oct9).day, false, "or September 10: neither is grounded");
    assert.deepEqual(quoteMentionsDate("Update 10/13/2026", parseDateValue("2026-10-13")!), { day: true, month: true, year: true }, "13 cannot be a month: month-first");
    assert.deepEqual(quoteMentionsDate("Update 13.10.2026", parseDateValue("2026-10-13")!), { day: true, month: true, year: true }, "day-first");
    assert.equal(quoteMentionsDate("Update 13.10.2026", parseDateValue("2026-10-13")!).day, true);
    assert.equal(quoteMentionsDate("Update 10/13/2026", parseDateValue("2026-01-10")!).day, false);
    assert.deepEqual(quoteMentionsDate("2026-09-10 release", sept10), { day: true, month: true, year: true }, "year-first is never ambiguous");
    assert.deepEqual(quoteMentionsDate("9/23/2025", sept23), { day: true, month: true, year: false }, "a numeric date carries its own year");
});

test("quoteMentionsTime requires the stated clock time when a value carries one", () => {
    assert.equal(quoteMentionsTime("26.19 September 23, 2026", parseDateValue("2026-09-23")!), true, "date-only values need no time");
    const t1500 = parseDateValue("2026-09-23T15:00")!;
    assert.equal(quoteMentionsTime("September 23 at 15:00 PT", t1500), true);
    assert.equal(quoteMentionsTime("September 23 at 3 PM PT", t1500), true);
    assert.equal(quoteMentionsTime("September 23 at 3:00 p.m.", t1500), true);
    assert.equal(quoteMentionsTime("September 23 at 3:17 PM", t1500), false);
    assert.equal(quoteMentionsTime("September 23, 2026", t1500), false, "no time in the quote");
    assert.equal(quoteMentionsTime("Patch 15 notes on September 23", t1500), false, "a bare number is not a time");
    assert.equal(quoteMentionsTime("PC: March 11, 00:00 - 08:30", parseDateValue("2026-03-11T00:00")!), true);
    assert.equal(quoteMentionsTime("servers go down at midnight", parseDateValue("2026-03-11T00:00")!), true);
    assert.equal(quoteMentionsTime("servers go down at midnight", parseDateValue("2026-03-11T00:00:59")!), false, "midnight has no seconds");
    assert.equal(quoteMentionsTime("servers return at noon", parseDateValue("2026-03-11T12:00:30")!), false);
    assert.equal(quoteMentionsTime("2026-09-09T18:00:00.000Z League of Legends Patch 26.18 Notes", parseDateValue("2026-09-09T18:00")!), true);
    assert.equal(quoteMentionsTime("at 12:00 AM", parseDateValue("2026-03-11T00:00")!), true);
    // Seconds are part of the claim: ":59" needs a quote that states it.
    assert.equal(quoteMentionsTime("September 23 at 15:00 PT", parseDateValue("2026-09-23T15:00:59")!), false);
    assert.equal(quoteMentionsTime("September 23 at 15:00:59 PT", parseDateValue("2026-09-23T15:00:59")!), true);
    assert.equal(quoteMentionsTime("2026-09-09T18:00:00.000Z", parseDateValue("2026-09-09T18:00:00")!), true);
});

test("zoneDeclaredIn accepts a zone only where the document declares it for its times", () => {
    const utc = resolveTimezone("UTC")!;
    const pt = resolveTimezone("PT")!;
    const kst = resolveTimezone("KST")!;
    const doc = "Live Maintenance Schedule (UTC) ※ PC: March 11, 00:00 - 08:30. Patches release on a Wednesday (PT) unless otherwise indicated.";
    assert.equal(zoneDeclaredIn(doc, utc), true);
    assert.equal(zoneDeclaredIn(doc, pt), true);
    assert.equal(zoneDeclaredIn(doc, kst), false);
    assert.equal(zoneDeclaredIn("All times are Pacific Time.", pt), true);
    assert.equal(zoneDeclaredIn("Times shown in KST. Patch 26.19 lands September 23", kst), true);
    assert.equal(zoneDeclaredIn("Patch Scheduled Date (Pacific Time) 26.01 January 8, 2026", pt), true, "a table header declares the zone");
    assert.equal(zoneDeclaredIn("Dates are listed in Korea Standard Time", resolveTimezone("KST")!), true);
    assert.equal(zoneDeclaredIn("Shown in the PT time zone", pt), true);
    // A zone stated for something else, or attached to another clock time, does not apply to dated events.
    assert.equal(zoneDeclaredIn("PC maintenance September 23 at 15:00. Support hours are PT.", pt), false);
    assert.equal(zoneDeclaredIn("PC maintenance September 23 at 15:00. Support is available 9-5 PT during maintenance.", pt), false);
    assert.equal(zoneDeclaredIn("Maintenance is scheduled; call 9 PT for help", pt), false);
    assert.equal(zoneDeclaredIn("Contact us (PT office). Patch 26.19 lands September 23 at 15:00", pt), false);
    // Abbreviations must stand alone: "PT" is not inside "September", "ET" is not inside "Internet".
    assert.equal(zoneDeclaredIn("Patch 26.19 releases September 23, 2026 at 15:00", pt), false);
    assert.equal(zoneDeclaredIn("Internet time issues resolved", resolveTimezone("ET")!), false);
});

test("clockTimesIn lists times in order and ignores bare numbers", () => {
    assert.deepEqual(clockTimesIn("PC: March 11, 00:00 - 08:30"), [0, 510]);
    assert.deepEqual(clockTimesIn("at 3 PM and later 11:45 pm, patch 26"), [900, 1425]);
    assert.deepEqual(clockTimesIn("Patch 26.19 September 23, 2026"), []);
});

test("dateSegment isolates the part of a quote that belongs to one date", () => {
    const sept23 = parseDateValue("2026-09-23T15:00")!;
    const sept24 = parseDateValue("2026-09-24T18:00")!;
    const two = "PC: patch 26.19 releases September 23 at 15:00 PT; Console: patch 26.19 releases September 24 at 18:00 ET";
    assert.equal(dateSegment(two, sept23), "pc: patch 26.19 releases september 23 at 15:00 pt");
    assert.equal(dateSegment(two, sept24), "console: patch 26.19 releases september 24 at 18:00 et");
    assert.equal(quoteMentionsTime(dateSegment(two, sept23)!, parseDateValue("2026-09-23T18:00")!), false, "the other entry's time is not evidence");
    // Time before the date, in the same clause.
    assert.equal(dateSegment("Servers go down at 15:00 PT on September 23 for maintenance", sept23), "servers go down at 15:00 pt on september 23 for maintenance");
    // Maintenance windows: the segment keeps both times of its own entry only.
    const windows = "PC: March 11, 00:00 - 08:30. Console: March 19, 01:00 - 09:00";
    assert.equal(dateSegment(windows, parseDateValue("2026-03-11T00:00")!), "pc: march 11, 00:00 - 08:30");
    assert.equal(dateSegment(windows, parseDateValue("2026-03-19T01:00")!), "console: march 19, 01:00 - 09:00");
    // A window that straddles its date keeps the clock before the date.
    const straddle = "Maintenance starts at 15:00 PT on September 23, 2026 and ends at 18:00 PT";
    assert.equal(dateSegment(straddle, sept23), "maintenance starts at 15:00 pt on september 23, 2026 and ends at 18:00 pt");
    assert.equal(quoteMentionsTime(dateSegment(straddle, sept23)!, sept23), true);
    // ...unless an earlier date in the same clause owns that clock.
    const chained = "Patch 26.19 September 23 15:00 PT Patch 26.20 October 7 18:00 PT";
    assert.equal(dateSegment(chained, parseDateValue("2026-10-07T18:00")!), "october 7 18:00 pt");
    assert.equal(quoteMentionsTime(dateSegment(chained, parseDateValue("2026-10-07T15:00")!)!, parseDateValue("2026-10-07T15:00")!), false);
    // "Sept. 23" is not a clause boundary.
    assert.equal(dateSegment("Sept. 23 at 3 PM PT", sept23), "sept. 23 at 3 pm pt");
    assert.equal(dateSegment("no date here", sept23), undefined);
    // Several entries on the same day yield one segment each.
    const sameDay = "PC maintenance September 23 at 15:00 PT; Console maintenance September 23 at 18:00 ET";
    assert.deepEqual(dateSegments(sameDay, sept23), ["pc maintenance september 23 at 15:00 pt", "console maintenance september 23 at 18:00 et"]);
    assert.deepEqual(dateSegments("no date here", sept23), []);
});

test("zonesIn finds stated timezone phrases", () => {
    assert.deepEqual(zonesIn("September 23 at 15:00 PT").map(z => z.zone), ["America/Los_Angeles"]);
    assert.deepEqual(zonesIn("all times are Pacific Time (PDT)").map(z => z.zone), ["America/Los_Angeles", "-07:00"]);
    assert.deepEqual(zonesIn("Maintenance (UTC+8) starts").map(z => z.zone), ["+08:00"]);
    assert.deepEqual(zonesIn("Live Maintenance Schedule (UTC)").map(z => z.zone), ["UTC"]);
    assert.deepEqual(zonesIn("Patch 26.19 releases September 23, 2026"), [], "no zone words, no zones");
    assert.deepEqual(zonesIn("Internet time is fun"), []);
    assert.deepEqual(zonesIn("2026-09-09T18:00:00.000Z League of Legends Patch 26.18 Notes").map(z => z.zone), ["UTC"], "an ISO Z states UTC");
});

test("zoneAfterClock pairs each clock with the zone that follows it", () => {
    const row = "Patch 26.19 releases September 23 at 15:00 PT / 18:00 ET / 22:00 UTC";
    assert.equal(zoneAfterClock(row, parseDateValue("2026-09-23T15:00")!)?.zone, "America/Los_Angeles");
    assert.equal(zoneAfterClock(row, parseDateValue("2026-09-23T18:00")!)?.zone, "America/New_York");
    assert.equal(zoneAfterClock(row, parseDateValue("2026-09-23T22:00")!)?.zone, "UTC");
    assert.equal(zoneAfterClock(row, parseDateValue("2026-09-23T09:00")!), undefined, "no such clock");
    assert.equal(zoneAfterClock("September 23 at 3 PM PT and 6 PM", parseDateValue("2026-09-23T18:00")!), undefined, "no zone after the second clock");
    assert.equal(zoneAfterClock("September 23 at 3 PM PT and 6 PM", parseDateValue("2026-09-23T15:00")!)?.zone, "America/Los_Angeles");
    assert.equal(zoneAfterClock("September 23, 2026", parseDateValue("2026-09-23")!), undefined, "date-only values have no clock");
});
