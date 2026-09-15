import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDateFact, parseDateValue, quoteMentionsDate, resolveTimezone, zonedToUtc } from "../ai/dates";

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
    assert.equal(zonedToUtc(sept, "America/Los_Angeles").toISOString(), "2026-09-23T22:00:00.000Z");
    const jan = parseDateValue("2026-01-08T15:00")!;
    assert.equal(zonedToUtc(jan, "America/Los_Angeles").toISOString(), "2026-01-08T23:00:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-09-23T04:00")!, "+08:00").toISOString(), "2026-09-22T20:00:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-09-23T04:00")!, "UTC").toISOString(), "2026-09-23T04:00:00.000Z");
    assert.equal(zonedToUtc(parseDateValue("2026-09-23T00:00")!, "Asia/Seoul").toISOString(), "2026-09-22T15:00:00.000Z");
});

test("normalizeDateFact decides precision from what was stated", () => {
    assert.deepEqual(normalizeDateFact("2026-09-23", "PT"), { at: "2026-09-23T00:00:00.000Z", precision: "day", timezone: "America/Los_Angeles" });
    assert.deepEqual(normalizeDateFact("2026-09-23", ""), { at: "2026-09-23T00:00:00.000Z", precision: "day", timezone: undefined });
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
});
