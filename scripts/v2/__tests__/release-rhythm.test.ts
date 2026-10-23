/**
 * The recorded history in numbers: facts about what happened, never a forecast, never more than the
 * record supports, and never a second answer to a question /resets/ already answers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { KnowledgeEvent, GameKnowledge } from "../../render-data-blocks";
import { formatDate, renderSite } from "../../render-pages";
import { RhythmOptions, cadenceFor, cadenceOf, isScheduleTopic, releaseRhythm, rhythmFor, scheduleRhythm, seriesOf, utcDaysBetween } from "../../release-rhythm";

const DAY = 86_400_000;
const NOW = new Date("2026-10-22T12:00:00Z");

function event(key: string, at: string, extra: Partial<KnowledgeEvent> = {}): KnowledgeEvent {
    return { key: `g/last-patch/${key}`, game: "g", topic: "last-patch", kind: "version", label: key, status: "observed", at, precision: "exact", publishState: "published", ...extra };
}

function options(extra: Partial<RhythmOptions> = {}): RhythmOptions {
    return { format: (iso: string) => formatDate(iso), now: NOW, evidenced: () => true, ...extra };
}

const row = (block: { rows: Array<{ label: string; when: string }> } | undefined, label: string) => block?.rows.find(r => r.label === label)?.when;

test("days are counted in UTC calendar days, so daylight saving changes nothing", () => {
    // Europe moved its clocks on 2026-03-29 and the US on 2026-03-08; UTC moved for neither.
    assert.equal(utcDaysBetween(Date.parse("2026-03-28T23:30:00Z"), Date.parse("2026-03-29T00:30:00Z")), 1);
    assert.equal(utcDaysBetween(Date.parse("2026-03-07T12:00:00Z"), Date.parse("2026-03-09T12:00:00Z")), 2);
    assert.equal(utcDaysBetween(Date.parse("2026-10-24T23:59:00Z"), Date.parse("2026-10-25T00:01:00Z")), 1);
    assert.equal(utcDaysBetween(Date.parse("2026-10-14T00:01:00Z"), Date.parse("2026-10-14T23:59:00Z")), 0);
});

test("a release feed in numbers: since the last one, recent count, the gaps, and where the record starts", () => {
    const k: GameKnowledge = { events: [
        event("1", "2026-08-01T10:00:00Z"), event("2", "2026-08-29T10:00:00Z"), event("3", "2026-09-26T10:00:00Z"), event("4", "2026-10-14T10:00:00Z")
    ] };
    const block = releaseRhythm(k, "last-patch", "last-patch", options({ cadence: "About every 4 weeks" }))!;
    assert.equal(block.title, "Patches in numbers");
    assert.equal(row(block, "Last recorded patch"), "8 days ago, on October 14, 2026");
    assert.equal(row(block, "In the last 90 days"), "4 patches");
    assert.equal(row(block, "How often"), "About every 4 weeks", "the hub's answer, word for word");
    assert.equal(row(block, "Shortest gap"), "18 days");
    assert.equal(row(block, "Longest gap"), "28 days");
    assert.equal(row(block, "Recent gaps, newest first"), "18, 28, 28 days");
    assert.equal(row(block, "Counted from"), "4 patches recorded since August 1, 2026");
    assert.match(block.note!, /The record starts on August 1, 2026; anything earlier is not counted/);
    assert.match(block.note!, /not when the next one will come/);
});

test("it never forecasts", () => {
    const k: GameKnowledge = { events: Array.from({ length: 8 }, (_, i) => event(String(i), new Date(NOW.getTime() - (200 - i * 20) * DAY).toISOString())) };
    const block = releaseRhythm(k, "last-patch", "last-patch", options())!;
    const text = [block.title, block.note, ...block.rows.flatMap(r => [r.label, r.when])].join(" ");
    assert.doesNotMatch(text, /overdue|expected|due (in|on)|next (patch|update|release) (in|on|around)|should|likely|predict/i);
});

test("without a rhythm the page says so, and with too little history it says that instead", () => {
    const uneven: GameKnowledge = { events: ["2026-05-01", "2026-05-02", "2026-06-20", "2026-06-21", "2026-09-30"].map((d, i) => event(String(i), `${d}T10:00:00Z`)) };
    assert.equal(row(releaseRhythm(uneven, "last-patch", "last-patch", options()), "How often"), "No regular rhythm in the recorded history");
    const short: GameKnowledge = { events: [event("a", "2026-09-01T10:00:00Z"), event("b", "2026-10-01T10:00:00Z")] };
    assert.equal(row(releaseRhythm(short, "last-patch", "last-patch", options()), "How often"), "Too few recorded to tell (2 so far)");
    assert.equal(releaseRhythm({ events: [event("a", "2026-09-01T10:00:00Z")] }, "last-patch", "last-patch", options()), undefined, "one release has no gaps");
    assert.equal(releaseRhythm({ events: [] }, "last-patch", "last-patch", options()), undefined);
    assert.equal(releaseRhythm(undefined, "last-patch", "last-patch", options()), undefined);
});

test("duplicates count once; held, future and unevidenced events are not releases", () => {
    const k: GameKnowledge = { events: [
        event("a", "2026-09-01T10:00:00Z"),
        event("a-repost", "2026-09-01T10:00:00Z"),
        event("b", "2026-09-15T10:00:00Z"),
        event("held", "2026-09-20T10:00:00Z", { publishState: "held" }),
        event("future", "2026-10-30T10:00:00Z"),
        event("no-evidence", "2026-10-01T10:00:00Z"),
        event("c", "2026-10-13T10:00:00Z")
    ] };
    const block = releaseRhythm(k, "last-patch", "last-patch", options({ evidenced: e => !e.key.endsWith("no-evidence") }))!;
    assert.equal(row(block, "Counted from"), "3 patches recorded since September 1, 2026");
    assert.equal(row(block, "Recent gaps, newest first"), "28, 14 days");
});

test("two title years are measured separately: the newest one is described, named as the publisher names it", () => {
    const k: GameKnowledge = { events: [
        event("fc26-1.6.4", "2026-07-14T12:00:00Z"), event("fc26-1.6.5", "2026-07-22T14:00:00Z"),
        event("fc27-1.0.1", "2026-09-23T12:00:00Z"), event("fc27-1.0.3", "2026-10-02T10:00:00Z"), event("fc27-1.0.4", "2026-10-07T11:00:00Z")
    ] };
    assert.equal(seriesOf(k.events![0]), "fc26");
    assert.equal(seriesOf(event("43.2", "2026-10-13T06:00:00Z")), undefined, "a version number is not a series");
    assert.equal(seriesOf(event("call-of-duty-bo7-warzone-season-06-patch-notes-2026-10-14", "2026-10-14T00:00:00Z")), undefined);
    const block = releaseRhythm(k, "last-patch", "last-title-update", options())!;
    assert.equal(row(block, "Counted from"), "3 title updates of FC 27 recorded since September 23, 2026");
    assert.equal(row(block, "Recent gaps, newest first"), "5, 9 days", "no gap across the two games");
    assert.equal(row(block, "How often"), "No regular rhythm in the recorded history", "cadenceOf judged all five; there were enough to judge");
});

test("a published schedule in numbers: the next date, the gaps, and that past dates were announced, not confirmed", () => {
    const k: GameKnowledge = { events: ["2026-09-10", "2026-09-23", "2026-10-07", "2026-10-21", "2026-11-04", "2026-11-18"].map((d, i) =>
        ({ ...event(`26.${18 + i}`, `${d}T00:00:00Z`, { precision: "day", status: new Date(`${d}T00:00:00Z`) > NOW ? "scheduled" : "observed" }), topic: "next-patch", key: `lol/next-patch/26.${18 + i}` })) };
    const block = scheduleRhythm(k, "next-patch", options({ currentKey: "lol/next-patch/26.22", headlineAnswered: true, cadence: "About every 2 weeks" }))!;
    assert.equal(row(block, "Next scheduled"), "26.22, in 13 days (November 4, 2026)");
    assert.equal(row(block, "How often"), "About every 2 weeks");
    assert.equal(row(block, "Gaps on the schedule, latest first"), "14, 14, 14, 14, 13 days");
    assert.match(block.note!, /not a confirmed release/);
    const unanswered = scheduleRhythm(k, "next-patch", options({ currentKey: "lol/next-patch/26.22", headlineAnswered: false }))!;
    assert.equal(row(unanswered, "Next scheduled"), undefined, "a page with no answer does not name the next date below it");
});

test("on a built site, each page's \"How often\" is exactly what /resets/ publishes for that game", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-rhythm-root-"));
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-rhythm-"));
    const repo = path.join(__dirname, "..", "..", "..");
    try {
        fs.cpSync(path.join(repo, "public"), dist, { recursive: true });
        for (const file of fs.readdirSync(path.join(repo, "public", "data", "_lkg"))) {
            if (file.endsWith(".json")) fs.copyFileSync(path.join(repo, "public", "data", "_lkg", file), path.join(dist, "data", file));
        }
        // PUBG every 28 days (a rhythm), CS2 irregular (none), each release evidenced by a linked claim.
        const games = path.join(root, "knowledge", "games");
        fs.mkdirSync(games, { recursive: true });
        const series: Record<string, { type: string; offsets: number[] }> = {
            pubg: { type: "last-patch", offsets: [140, 112, 84, 56, 28, 0] },
            cs2: { type: "last-update", offsets: [60, 59, 40, 12, 11, 3] }
        };
        for (const [game, { type, offsets }] of Object.entries(series)) {
            const events = offsets.map((back, i) => {
                const at = new Date(NOW.getTime() - back * DAY - 3600_000).toISOString();
                return { key: `${game}/${type}/f${i}`, game, topic: type, kind: "version", label: `Fixture ${i}`, status: "observed", at, precision: "exact", timezone: "UTC", firstSeen: at, lastVerified: NOW.toISOString(), publishState: "published" };
            });
            const claims = events.map((e, i) => ({ id: `c${i}`, documentId: "d", eventKey: e.key, field: "at", value: e.at, method: "deterministic", quote: "{}", linkUrl: `https://example.invalid/${game}/${i}`, extractedAt: e.at }));
            fs.writeFileSync(path.join(games, `${game}.json`), JSON.stringify({
                schemaVersion: 1, game, updatedAt: NOW.toISOString(), events, changes: [], overrides: [],
                documents: [{ id: "d", url: "https://example.invalid/feed", sourceId: "s", fetchedAt: NOW.toISOString(), fetchMode: "http" }],
                claims, sources: [], discovered: [], topicStates: []
            }, null, 2));
        }
        renderSite(dist, NOW, root);

        const hub = cheerio.load(fs.readFileSync(path.join(dist, "resets", "index.html"), "utf8"));
        const hubCadence = (name: string) => {
            const r = hub("table tbody tr").filter((_, tr) => hub(tr).text().includes(name)).first();
            return r.find("td").eq(1).text().trim();
        };
        const pageCadence = (page: string) => {
            const $ = cheerio.load(fs.readFileSync(path.join(dist, page), "utf8"));
            const li = $("#verified-data li").filter((_, el) => $(el).find(".data-label").text() === "How often").first();
            return li.find(".data-when").text().trim();
        };
        assert.equal(hubCadence("PUBG"), "About every 4 weeks");
        assert.equal(pageCadence("pubg/last-patch/index.html"), hubCadence("PUBG"));
        assert.equal(hubCadence("Counter-Strike 2"), "—");
        assert.equal(pageCadence("cs2/last-update/index.html"), "No regular rhythm in the recorded history");
        assert.equal(cadenceOf(JSON.parse(fs.readFileSync(path.join(games, "pubg.json"), "utf8")), "last-patch", undefined, NOW), "About every 4 weeks");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(dist, { recursive: true, force: true });
    }
});

test("a schedule keeps its numbers before its first date and after its last, when no timeline renders", () => {
    const schedule = (offsets: number[]): GameKnowledge => ({ events: offsets.map((d, i) => ({
        key: `lol/next-patch/27.0${i + 1}`, game: "lol", topic: "next-patch", kind: "version", label: `27.0${i + 1}`,
        status: d > 0 ? "scheduled" : "observed", at: new Date(NOW.getTime() + d * DAY).toISOString().slice(0, 10) + "T00:00:00.000Z",
        precision: "day", publishState: "published"
    })) });
    for (const k of [schedule([20, 34, 48, 62]), schedule([-62, -48, -34, -20])]) {
        assert.equal(isScheduleTopic(k, "next-patch"), true);
        assert.equal(rhythmFor(k, "next-patch", options())?.title, "The schedule in numbers");
    }
    // A next-banner topic is not a schedule of versions, and a release feed stays a release feed.
    assert.equal(isScheduleTopic({ events: [event("x", "2026-11-03T06:59:00Z", { topic: "next-banner", kind: "occurrence", key: "g/next-banner/x" })] }, "next-banner"), false);
    const feed: GameKnowledge = { events: [event("1", "2026-09-01T10:00:00Z"), event("2", "2026-10-01T10:00:00Z")] };
    assert.equal(rhythmFor(feed, "last-patch", options())?.title, "Patches in numbers");
});

test("with an unanswered headline, the schedule's numbers use past dates only", () => {
    const days = [-40, -26, -12, 2, 16, 30];
    const k: GameKnowledge = { events: days.map((d, i) => ({
        key: `lol/next-patch/26.${20 + i}`, game: "lol", topic: "next-patch", kind: "version", label: `26.${20 + i}`,
        status: d > 0 ? "scheduled" : "observed", at: new Date(NOW.getTime() + d * DAY).toISOString().slice(0, 10) + "T00:00:00.000Z",
        precision: "day", publishState: "published"
    })) };
    const answered = scheduleRhythm(k, "next-patch", options({ headlineAnswered: true, currentKey: "lol/next-patch/26.23" }))!;
    assert.match(row(answered, "Counted from")!, /^6 dates/);
    // Three past dates are too few for the block: it is left out rather than built from the hidden future.
    assert.equal(scheduleRhythm(k, "next-patch", options({ headlineAnswered: false })), undefined);
    const longer: GameKnowledge = { events: [...k.events!, ...[-54, -68].map((d, i) => ({ ...k.events![0], key: `lol/next-patch/26.1${8 - i}`, label: `26.1${8 - i}`, at: new Date(NOW.getTime() + d * DAY).toISOString().slice(0, 10) + "T00:00:00.000Z" }))] };
    const unanswered = scheduleRhythm(longer, "next-patch", options({ headlineAnswered: false }))!;
    const counted = row(unanswered, "Counted from")!;
    assert.match(counted, /^5 dates/);
    assert.ok(!/November|December/.test(counted), `no future date named: ${counted}`);
    assert.equal(row(unanswered, "Next scheduled"), undefined);
});

test("a completed schedule keeps its rhythm; a release feed that went quiet loses it", () => {
    // Fourteen-day schedule whose last date was 29 days ago: the year is over, the schedule was regular.
    const schedule: GameKnowledge = { events: [-99, -85, -71, -57, -43, -29].map((d, i) => ({
        key: `lol/next-patch/26.2${i}`, game: "lol", topic: "next-patch", kind: "version", label: `26.2${i}`, status: "observed",
        at: new Date(NOW.getTime() + d * DAY).toISOString().slice(0, 10) + "T00:00:00.000Z", precision: "day", publishState: "published"
    })) };
    assert.equal(cadenceOf(schedule, "next-patch", undefined, NOW), undefined, "the feed rule alone would drop it");
    assert.equal(cadenceFor(schedule, "next-patch", NOW), "About every 2 weeks");
    // The same spacing as a release feed that stopped: no rhythm is claimed for it.
    const feed: GameKnowledge = { events: schedule.events!.map(e => ({ ...e, topic: "last-patch", key: e.key.replace("next-patch", "last-patch") })) };
    assert.equal(cadenceFor(feed, "last-patch", NOW), undefined);
});
