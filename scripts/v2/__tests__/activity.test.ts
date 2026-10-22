/**
 * Across every game: published releases and announced dates, kept apart, each with its provenance,
 * and nothing projected from a rhythm.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { GameKnowledge, KnowledgeEvent } from "../../render-data-blocks";
import { TrackerData } from "../../render-pages";
import { RECENT_ACTIVITY_DAYS, UPCOMING_ACTIVITY_DAYS, activityFor, activityHtml, displayLabel, renderActivityHtml } from "../../render-activity";

const NOW = new Date("2026-10-23T08:00:00.000Z");
const DAY = 86_400_000;
const PAGE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "public", "resets", "index.html"), "utf8");
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * DAY).toISOString();

function ev(game: string, topic: string, id: string, at: string, extra: Partial<KnowledgeEvent> = {}): KnowledgeEvent {
    return { key: `${game}/${topic}/${id}`, game, topic, kind: "version", label: id, status: "observed", at, precision: "exact", publishState: "published", ...extra };
}

function store(events: KnowledgeEvent[], unevidenced: string[] = []): GameKnowledge {
    return {
        events,
        claims: events.filter(e => !unevidenced.includes(e.key)).map(e => ({ eventKey: e.key, field: "at", value: e.at, method: "deterministic", quote: "{}", linkUrl: `https://official.example/${e.key}` })),
        documents: []
    };
}

const fresh = (game: string, type: string, at: string, precision = "exact"): TrackerData => ({
    game, type, status: "fresh", nextEventUtc: at, precision, fetched_at_utc: NOW.toISOString(), last_success_at_utc: NOW.toISOString(), source_url: "https://official.example", confidence: "high"
});

function fixture() {
    const knowledge: Record<string, GameKnowledge> = {
        cs2: store([ev("cs2", "last-update", "a", iso(-3), { kind: "occurrence", label: "Counter-Strike 2 Update" }), ev("cs2", "last-update", "b", iso(-20), { kind: "occurrence", label: "Counter-Strike 2 Update" })]),
        pubg: store([ev("pubg", "last-patch", "43.2", iso(-10)), ev("pubg", "last-patch", "43.2-repost", iso(-10)), ev("pubg", "last-patch", "no-link", iso(-5))], ["pubg/last-patch/no-link"]),
        lol: store([
            ev("lol", "next-patch", "26.21", iso(-2), { precision: "day", at: iso(-2).slice(0, 10) + "T00:00:00.000Z" }),
            ev("lol", "next-patch", "26.22", iso(12).slice(0, 10) + "T00:00:00.000Z", { precision: "day", status: "scheduled" }),
            ev("lol", "next-patch", "26.24", iso(47).slice(0, 10) + "T00:00:00.000Z", { precision: "day", status: "scheduled" })
        ]),
        gta: store([ev("gta", "weekly-reset", "rule", iso(6), { kind: "recurring", status: "scheduled", label: "Weekly reset" })]),
        genshin: store([ev("genshin", "next-banner", "phase", iso(11), { status: "scheduled", kind: "occurrence", label: "Banner A / Banner B: ends 2026-11-03 14:59 server time (Asia 06:59 UTC, Europe 13:59 UTC, America 19:59 UTC)" })]),
        // A held event is ours to know, not to publish.
        valorant: store([ev("valorant", "last-patch", "13.09", iso(-1), { publishState: "held" })])
    };
    const data: Record<string, TrackerData> = {
        "lol/next-patch": fresh("lol", "next-patch", iso(12).slice(0, 10) + "T00:00:00.000Z", "day"),
        "gta/weekly-reset": fresh("gta", "weekly-reset", iso(6)),
        "genshin/next-banner": fresh("genshin", "next-banner", iso(11))
    };
    return { knowledge, data };
}

test("published and scheduled are separate lists, each in its own order", () => {
    const { knowledge, data } = fixture();
    const activity = activityFor({ read: (g, t) => data[`${g}/${t}`], knowledge: g => knowledge[g], now: NOW });
    assert.deepEqual(activity.published.map(i => `${i.game}: ${i.label}`), ["Counter-Strike 2: Counter-Strike 2 Update", "PUBG: Patch 43.2"], "newest first; duplicate instant once; unevidenced and held left out; 20 days ago is outside the window");
    assert.deepEqual(activity.scheduled.map(i => `${i.game}: ${i.label}`), ["Genshin Impact: Banner A / Banner B: phase ends (Asia servers first)", "League of Legends: Patch 26.22"], "soonest first; 47 days out is outside the window");
});

test("a passed schedule date is not a release, and a computed rule is not an announcement", () => {
    const { knowledge, data } = fixture();
    const activity = activityFor({ read: (g, t) => data[`${g}/${t}`], knowledge: g => knowledge[g], now: NOW });
    assert.ok(!activity.published.some(i => i.label.includes("26.21")), "LoL 26.21's date passed; the schedule does not say it shipped");
    assert.ok(![...activity.published, ...activity.scheduled].some(i => i.game === "GTA Online"), "GTA's weekly reset is computed");
});

test("nothing is projected from a rhythm: a regular release feed with no announcement schedules nothing", () => {
    const regular = store([0, 1, 2, 3, 4, 5].map(i => ev("pubg", "last-patch", `4${i}.1`, iso(-1 - i * 28))));
    const activity = activityFor({ read: () => undefined, knowledge: g => (g === "pubg" ? regular : undefined), now: NOW });
    assert.equal(activity.scheduled.length, 0);
});

test("a tracker whose page cannot answer does not announce its next date here", () => {
    const { knowledge, data } = fixture();
    delete data["lol/next-patch"];
    const activity = activityFor({ read: (g, t) => data[`${g}/${t}`], knowledge: g => knowledge[g], now: NOW });
    assert.ok(!activity.scheduled.some(i => i.game === "League of Legends"));
});

test("each entry links to its official source, and to its tracker only where that page is listed", () => {
    const { knowledge, data } = fixture();
    knowledge.roblox = store([ev("roblox", "status", "s", iso(-1), { kind: "occurrence", label: "Status change" })]);
    const html = activityHtml(activityFor({ read: (g, t) => data[`${g}/${t}`], knowledge: g => knowledge[g], now: NOW }));
    const $ = cheerio.load(html);
    $("li").each((_, li) => {
        const links = $(li).find("a").map((_, a) => $(a).attr("href")).get();
        assert.ok(links.some(href => href.startsWith("https://official.example/")), `no source link: ${$(li).text()}`);
    });
    assert.equal($('a[href="/cs2/last-update/"]').length, 1);
    assert.doesNotMatch(html, /Status change/, "a status change is not a release");
});

test("empty lists say what is missing without claiming nothing happened", () => {
    const html = activityHtml({ published: [], scheduled: [] });
    assert.match(html, new RegExp(`Nothing recorded from the official sources in the last ${RECENT_ACTIVITY_DAYS} days`));
    assert.match(html, new RegExp(`No publisher has announced a date in the next ${UPCOMING_ACTIVITY_DAYS} days that this site has verified`));
});

test("labels are readable out of their own page", () => {
    assert.equal(displayLabel("26.22", "next-patch"), "Patch 26.22");
    assert.equal(displayLabel("26.3", "last-release"), "Release 26.3");
    assert.equal(displayLabel("VALORANT Patch Notes 13.08", "last-patch"), "VALORANT Patch Notes 13.08");
    assert.equal(displayLabel("Banner: ends 2026-11-03 14:59 server time (Asia 06:59 UTC)", "next-banner"), "Banner: phase ends (Asia servers first)");
});

test("the hub declares exactly one region for it, and a page without one fails the build", () => {
    const rendered = renderActivityHtml(PAGE, { published: [], scheduled: [] });
    assert.match(rendered, /<h3>Published in the last 14 days<\/h3>/);
    assert.throws(() => renderActivityHtml(PAGE.replace('data-nr-region="activity"', ""), { published: [], scheduled: [] }), /exactly one "activity" region/);
});
