/**
 * The two columns that make /resets/ a comparison rather than a list of dates: how far each value is
 * from today, and how many releases this site recorded lately. Both are arithmetic on data the build
 * already has, and both must agree with what each tracker page says about the same game.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { GameKnowledge, KnowledgeEvent, MAX_HISTORY_ROWS, isEvidenced } from "../../render-data-blocks";
import { TrackerData, formatDate } from "../../render-pages";
import { releaseRhythm } from "../../release-rhythm";
import { renderResetsHtml, resetRows } from "../../render-resets";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const DAY = 86_400_000;
const PAGE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "public", "resets", "index.html"), "utf8");

const answered = (game: string, type: string, at: string, precision = "exact"): TrackerData => ({
    game, type, status: "fresh", nextEventUtc: at, precision,
    fetched_at_utc: NOW.toISOString(), last_success_at_utc: NOW.toISOString(),
    source_url: "https://example.com", confidence: "high"
});

function pubgKnowledge(): GameKnowledge {
    // Six patches, 28 days apart, the newest 9 days ago, each evidenced by a linked claim.
    const events: KnowledgeEvent[] = [0, 1, 2, 3, 4, 5].map(i => ({
        key: `pubg/last-patch/4${i}.1`, game: "pubg", topic: "last-patch", kind: "version", label: `Update 4${i}.1`,
        status: "observed", at: new Date(NOW.getTime() - (9 + (5 - i) * 28) * DAY).toISOString(), precision: "exact", publishState: "published"
    }));
    return { game: "pubg", events, claims: events.map(e => ({ eventKey: e.key, field: "at", value: e.at, method: "deterministic", quote: "{}", linkUrl: `https://example.invalid/${e.key}` })), documents: [] };
}

function rows(read: (game: string, type: string) => TrackerData | undefined, knowledge: (game: string) => GameKnowledge | undefined = () => undefined) {
    return resetRows({ read, knowledge, now: NOW });
}

test("From today counts UTC calendar days, either way, and says nothing without a value", () => {
    const at: Record<string, string> = {
        "gta/weekly-reset": "2026-10-29T10:00:00.000Z",
        "lol/next-patch": "2026-10-22T00:00:00.000Z",
        "genshin/next-banner": "2026-10-23T06:59:00.000Z",
        "cs2/last-update": "2026-10-14T23:02:00.000Z",
        "minecraft/last-release": "2026-10-21T23:59:00.000Z"
    };
    const built = rows((game, type) => {
        const value = at[`${game}/${type}`];
        return value ? answered(game, type, value, game === "lol" ? "day" : "exact") : undefined;
    });
    const distance = (game: string) => built.find(r => r.game === game)!.distance;
    assert.equal(distance("gta"), "in 7 days");
    assert.equal(distance("lol"), "Today", "a date-only value on its own day is today");
    assert.equal(distance("genshin"), "in 1 day");
    assert.equal(distance("cs2"), "8 days ago");
    assert.equal(distance("minecraft"), "1 day ago", "one minute before midnight yesterday is yesterday");
    assert.equal(distance("valorant"), undefined, "no value, no distance");
});

test("Recorded, last 90 days is the tracker page's own count, and empty where there is nothing to count", () => {
    const knowledge = pubgKnowledge();
    const built = rows((game, type) => answered(game, type, game === "pubg" ? knowledge.events!.at(-1)!.at! : "2026-10-29T10:00:00.000Z"), game => (game === "pubg" ? knowledge : undefined));
    const pubg = built.find(r => r.game === "pubg")!;
    assert.equal(pubg.recorded, "3 patches", "patches 9, 37 and 65 days ago; 93 is outside the window");

    const block = releaseRhythm(knowledge, "last-patch", "last-patch", { format: (iso: string) => formatDate(iso), now: NOW, evidenced: e => isEvidenced(e, knowledge) })!;
    assert.equal(block.rows.find(r => r.label === "In the last 90 days")!.when, pubg.recorded, "the hub and the page count the same releases");

    for (const game of ["gta", "lol", "genshin", "roblox", "fortnite"]) {
        assert.equal(built.find(r => r.game === game)!.recorded, undefined, `${game} has no releases to count`);
    }
    assert.equal(built.find(r => r.game === "cs2")!.recorded, undefined, "a release feed with no recorded history shows a dash, not zero");
});

test("every row has a cell for every column, and the explanation names both new columns", () => {
    const html = renderResetsHtml(PAGE, rows((game, type) => answered(game, type, "2026-10-29T10:00:00.000Z")));
    const $ = cheerio.load(html);
    const headers = $("table thead th").map((_, th) => $(th).text()).get();
    assert.deepEqual(headers, ["Game", "What it tracks", "How often", "When (UTC)", "Your time", "From today", "Recorded, last 90 days", "Status"]);
    $("table tbody tr").each((_, tr) => assert.equal($(tr).find("th,td").length, headers.length));
    const text = $("body").text().replace(/\s+/g, " ");
    assert.match(text, /From today is how many days away the value is, counted in UTC calendar days/);
    assert.match(text, /not a guarantee that nothing else was released/);
    assert.doesNotMatch(text, /the same ones each tracker page lists and links/, "a page lists twelve; the count can be larger");
    assert.match(text, /the page lists the most recent twelve/);
    assert.equal(MAX_HISTORY_ROWS, 12, "the explanation says twelve; change it with the cap");
});

test("an observed update a little past the clock is not described as still ahead", () => {
    // 23:59:30 on 22 October, and the source stamped the update 00:00:20 on the 23rd: skew across midnight.
    const now = new Date("2026-10-22T23:59:30.000Z");
    const built = resetRows({ read: (game, type) => (game === "cs2" ? answered(game, type, "2026-10-23T00:00:20.000Z") : undefined), knowledge: () => undefined, now });
    assert.equal(built.find(r => r.game === "cs2")!.distance, "Today");
    // A genuinely upcoming value still counts forward.
    const upcoming = resetRows({ read: (game, type) => (game === "gta" ? answered(game, type, "2026-10-29T10:00:00.000Z") : undefined), knowledge: () => undefined, now });
    assert.equal(upcoming.find(r => r.game === "gta")!.distance, "in 7 days");
});

test("an observed update stamped a little past the clock is counted, and is \"Today\", not ahead", () => {
    const now = new Date("2026-10-22T23:59:30.000Z");
    const skewed = "2026-10-23T00:00:20.000Z";
    const k = pubgKnowledge();
    k.events!.push({ key: "pubg/last-patch/43.3", game: "pubg", topic: "last-patch", kind: "version", label: "Update 43.3", status: "observed", at: skewed, precision: "exact", publishState: "published" });
    k.claims!.push({ eventKey: "pubg/last-patch/43.3", field: "at", value: skewed, method: "deterministic", quote: "{}", linkUrl: "https://example.invalid/43.3" });
    const built = resetRows({ read: (game, type) => (game === "pubg" ? answered(game, type, skewed) : undefined), knowledge: g => (g === "pubg" ? k : undefined), now });
    const pubg = built.find(r => r.game === "pubg")!;
    assert.equal(pubg.distance, "Today");
    // 43.3 now, and the fixture's three inside the window: four.
    assert.equal(pubg.recorded, "4 patches", "the update the row shows is in the count");
    const block = releaseRhythm(k, "last-patch", "last-patch", { format: (iso: string) => formatDate(iso), now, evidenced: e => isEvidenced(e, k) })!;
    assert.equal(block.rows.find(r => r.label === "Last recorded patch")!.when, "Today");
});

test("an observation dated more than a day ahead is bad data: no distance, not \"Today\"", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const built = resetRows({ read: (game, type) => (game === "cs2" ? answered(game, type, "2026-10-25T12:00:00.000Z") : undefined), knowledge: () => undefined, now });
    assert.equal(built.find(r => r.game === "cs2")!.distance, undefined);
});
