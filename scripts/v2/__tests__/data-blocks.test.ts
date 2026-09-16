/**
 * Publishing V2, milestone 3: publish the schedules, history and regional data the store already holds.
 *
 * The rules under test are all "only what the data supports": a block appears when a game has enough
 * to fill it, a quote appears only when it is prose a person can read, and nothing is invented.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GameKnowledge, KnowledgeEvent, MIN_HISTORY_ROWS, blocksFor, computedOccurrences, loadKnowledge, regionalTimes, renderBlocks } from "../../render-data-blocks";
import { renderSite, tidyNotes } from "../../render-pages";

const NOW = new Date("2026-09-16T12:00:00Z");
const ROOT = path.join(__dirname, "..", "..", "..");
const format = (iso: string, precision?: string) => (precision === "exact" ? `${iso} (exact)` : iso.slice(0, 10));

function patch(version: string, at: string, status = "ended"): KnowledgeEvent {
    return { key: `lol/next-patch/${version}`, topic: "next-patch", kind: "version", label: version, status, at, precision: "day", publishState: "published" };
}

function lolKnowledge(): GameKnowledge {
    return {
        game: "lol",
        events: [
            patch("26.16", "2026-08-12T00:00:00.000Z"),
            patch("26.17", "2026-08-26T00:00:00.000Z"),
            patch("26.18", "2026-09-09T00:00:00.000Z"),
            patch("26.19", "2026-09-23T00:00:00.000Z", "scheduled"),
            patch("26.20", "2026-10-07T00:00:00.000Z", "scheduled"),
            patch("26.21", "2026-10-21T00:00:00.000Z", "scheduled")
        ],
        claims: [
            { eventKey: "lol/next-patch/26.20", field: "at", method: "ai", quote: "26.20 October 7, 2026" },
            { eventKey: "lol/next-patch/26.17", field: "at", method: "ai", quote: "26.17 August 26, 2026" }
        ],
        documents: []
    };
}

test("a game's blocks are exactly what its data supports", () => {
    const blocks = blocksFor(lolKnowledge(), "next-patch", { format, now: NOW, currentKey: "lol/next-patch/26.19" });
    assert.deepEqual(blocks.map(b => b.title), ["Also scheduled", "Previously"]);

    const scheduled = blocks[0];
    assert.deepEqual(scheduled.rows.map(r => r.label), ["26.20", "26.21"], "soonest first, and never the headline value again");
    assert.equal(scheduled.rows[0].quote, "26.20 October 7, 2026", "a prose quote is shown");

    const previously = blocks[1];
    assert.deepEqual(previously.rows.map(r => r.label), ["26.18", "26.17", "26.16"], "newest first");
});

test("a block that cannot be filled does not appear", () => {
    const thin: GameKnowledge = {
        events: [patch("26.18", "2026-09-09T00:00:00.000Z"), patch("26.17", "2026-08-26T00:00:00.000Z")],
        claims: [], documents: []
    };
    assert.equal(MIN_HISTORY_ROWS, 3);
    assert.deepEqual(blocksFor(thin, "next-patch", { format, now: NOW }).map(b => b.title), [], "two rows is not a history section");

    const single: GameKnowledge = { events: [patch("26.18", "2026-09-09T00:00:00.000Z")], claims: [], documents: [] };
    assert.deepEqual(blocksFor(single, "next-patch", { format, now: NOW }), [], "a one-event game gets nothing");

    assert.deepEqual(blocksFor(undefined, "next-patch", { format, now: NOW }), [], "and no knowledge at all is not an error");
});

test("a quote is shown only when it is prose a person can read", () => {
    const knowledge: GameKnowledge = {
        events: [
            { key: "cs2/last-update/a", topic: "last-update", label: "Counter-Strike 2 Update", status: "observed", at: "2026-09-09T22:51:08.000Z", precision: "exact", publishState: "published" },
            { key: "cs2/last-update/b", topic: "last-update", label: "Counter-Strike 2 Update", status: "observed", at: "2026-09-01T10:00:00.000Z", precision: "exact", publishState: "published" },
            { key: "cs2/last-update/c", topic: "last-update", label: "Counter-Strike 2 Update", status: "observed", at: "2026-08-24T23:39:00.000Z", precision: "exact", publishState: "published" }
        ],
        claims: [
            { eventKey: "cs2/last-update/a", field: "at", method: "deterministic", quote: `{"gid":"184","title":"Counter-Strike 2 Update"}`, documentId: "doc-a" },
            { eventKey: "cs2/last-update/b", field: "at", method: "deterministic", quote: `{"gid":"185"}`, linkUrl: "https://store.steampowered.com/news/b" },
            { eventKey: "cs2/last-update/c", field: "at", method: "deterministic", quote: `{"gid":"186"}`, documentId: "doc-c" }
        ],
        documents: [{ id: "doc-a", url: "https://store.steampowered.com/news/a" }, { id: "doc-c", url: "https://store.steampowered.com/news/c" }]
    };

    const blocks = blocksFor(knowledge, "last-update", { format, now: NOW });
    const rows = blocks[0].rows;
    assert.equal(blocks[0].title, "Previously");
    for (const row of rows) assert.equal(row.quote, undefined, "raw API JSON is never shown to a reader");
    assert.deepEqual(rows.map(r => r.href), [
        "https://store.steampowered.com/news/a",
        "https://store.steampowered.com/news/b",
        "https://store.steampowered.com/news/c"
    ], "each row links its own post, from the claim or its document");

    const html = renderBlocks(blocks);
    assert.ok(!html.includes("gid"), "and the payload never reaches the HTML");
    assert.ok(!html.includes("data-quote"));
});

test("the three regional times are read strictly, or not at all", () => {
    const label = 'The Lone Light Knocks at Night / Epitome Invocation: ends 2026-09-22 14:59 server time (Asia 06:59 UTC, Europe 13:59 UTC, America 19:59 UTC)';
    assert.deepEqual(regionalTimes(label), [
        { label: "Asia", when: "06:59 UTC" },
        { label: "Europe", when: "13:59 UTC" },
        { label: "America", when: "19:59 UTC" }
    ]);

    assert.deepEqual(regionalTimes("ends 2026-09-22 14:59 server time (Asia 06:59 UTC, Europe 13:59 UTC)"), [], "a missing region yields nothing rather than a guess");
    assert.deepEqual(regionalTimes("Patch 26.19"), [], "a label with no regions yields nothing");
    assert.deepEqual(regionalTimes("ends soon (Asia sometime, Europe 13:59 UTC, America 19:59 UTC)"), [], "an unparsable time yields nothing");
});

test("a recurring rule is projected forward and labelled as computed", () => {
    const gta: GameKnowledge = {
        events: [{ key: "gta/weekly-reset/2026-09-17", topic: "weekly-reset", kind: "recurring", label: "Weekly reset", status: "scheduled", at: "2026-09-17T10:00:00.000Z", precision: "exact", publishState: "published" }],
        claims: [], documents: []
    };
    const blocks = blocksFor(gta, "weekly-reset", { format, now: NOW, currentKey: "gta/weekly-reset/2026-09-17" });
    assert.deepEqual(blocks.map(b => b.title), ["Then"]);
    assert.match(blocks[0].note ?? "", /Computed/, "a computed projection says so");
    assert.equal(blocks[0].rows.length, 4);
    assert.deepEqual(computedOccurrences("2026-09-17T10:00:00.000Z", 7, 2, iso => iso).map(r => r.when), [
        "2026-09-24T10:00:00.000Z",
        "2026-10-01T10:00:00.000Z"
    ]);
    assert.deepEqual(computedOccurrences("not a date", 7, 2, iso => iso), []);
});

test("rendered blocks escape their content and vanish when empty", () => {
    assert.equal(renderBlocks([]), "");
    const html = renderBlocks([{ title: "Previously", rows: [{ label: `<script>x</script>`, when: "2026-09-09", href: `https://e.com/"onerror="x` }] }]);
    assert.ok(!html.includes("<script>x"), "a label cannot introduce markup");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes(`"onerror="`));
});

test("values a V1 provider ran together are separated, and everything else is left alone", () => {
    assert.equal(
        tidyNotes("Red Dead OnlineSeptember 1, 2026Distill Your Best Swill for Triple Rewards"),
        "Red Dead Online September 1, 2026 Distill Your Best Swill for Triple Rewards"
    );
    for (const untouched of ["Patch 26.19", "EA SPORTS FC 26 version 1.6.5", "Counter-Strike 2 Update", "Current status: Operational"]) {
        assert.equal(tidyNotes(untouched), untouched, `must not rewrite: ${untouched}`);
    }
});

test("renderSite fills the data slot from the store, and leaves it empty without one", () => {
    const make = (withKnowledge: boolean) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-m3-"));
        const dist = path.join(root, "dist");
        fs.mkdirSync(path.join(dist, "lol", "next-patch"), { recursive: true });
        fs.mkdirSync(path.join(dist, "data"), { recursive: true });
        fs.copyFileSync(path.join(ROOT, "public", "lol", "next-patch", "index.html"), path.join(dist, "lol", "next-patch", "index.html"));
        fs.writeFileSync(path.join(dist, "data", "lol.next-patch.json"), JSON.stringify({
            provider_id: "lol", game: "lol", type: "next-patch", status: "fresh",
            nextEventUtc: "2026-09-23T00:00:00.000Z", fetched_at_utc: NOW.toISOString(), last_success_at_utc: NOW.toISOString(),
            source_url: "https://support.riotgames.com/x", confidence: "high", notes: "Patch 26.19", precision: "day"
        }));
        if (withKnowledge) {
            fs.mkdirSync(path.join(root, "knowledge", "games"), { recursive: true });
            fs.writeFileSync(path.join(root, "knowledge", "games", "lol.json"), JSON.stringify(lolKnowledge()));
        }
        renderSite(dist, NOW, root);
        const html = fs.readFileSync(path.join(dist, "lol", "next-patch", "index.html"), "utf8");
        fs.rmSync(root, { recursive: true, force: true });
        return html;
    };

    const withStore = make(true);
    assert.ok(withStore.includes("<h2>Also scheduled</h2>"), "the schedule is published");
    assert.ok(withStore.includes("26.20") && withStore.includes("26.21"));
    assert.ok(!withStore.includes(">26.19<"), "the headline value is not repeated in a block");
    assert.ok(withStore.includes("September 23, 2026"), "and the headline value is still there");

    const withoutStore = make(false);
    assert.ok(withoutStore.includes(`<div id="verified-data"></div>`), "no store means an untouched, empty slot");
    assert.ok(withoutStore.includes("September 23, 2026"), "milestone 1 output is unaffected");
});

test("the knowledge store is optional", () => {
    assert.equal(loadKnowledge(os.tmpdir(), "definitely-not-a-game"), undefined);
});
