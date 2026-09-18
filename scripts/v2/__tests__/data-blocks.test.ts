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
import { emptyKnowledge } from "../domain";
import { locateSlot } from "../../render-slots";
import { GameKnowledge, KnowledgeEvent, MAX_HISTORY_ROWS, MIN_HISTORY_ROWS, blocksFor, computedOccurrences, loadKnowledge, regionalTimes, renderBlocks, timelineFor } from "../../render-data-blocks";
import { formatDate, formatDateTime, renderSite, tidyNotes } from "../../render-pages";

const NOW = new Date("2026-09-16T12:00:00Z");
const ROOT = path.join(__dirname, "..", "..", "..");

/** The data slot as the tracker template writes it, so this file does not paste a copy of the markup. */
const EMPTY_DATA_SLOT = locateSlot(
    fs.readFileSync(path.join(ROOT, "public", "lol", "next-patch", "index.html"), "utf8"),
    "verified-data",
    "lol/next-patch"
).source;
const format = (iso: string, precision?: string) => (precision === "exact" ? `${iso} (exact)` : iso.slice(0, 10));

function patch(version: string, at: string, status = "ended"): KnowledgeEvent {
    return { key: `lol/next-patch/${version}`, topic: "next-patch", kind: "version", label: version, status, at, precision: "day", publishState: "published" };
}

function lolKnowledge(): GameKnowledge {
    return {
        game: "lol",
        // Past patches as the real store holds them: "observed", because their release was seen. A
        // scheduled date that merely passes becomes "ended" instead (knowledge.ts), which is a different
        // and weaker claim — tested on its own below.
        events: [
            patch("26.16", "2026-08-12T00:00:00.000Z", "observed"),
            patch("26.17", "2026-08-26T00:00:00.000Z", "observed"),
            patch("26.18", "2026-09-09T00:00:00.000Z", "observed"),
            patch("26.19", "2026-09-23T00:00:00.000Z", "scheduled"),
            patch("26.20", "2026-10-07T00:00:00.000Z", "scheduled"),
            patch("26.21", "2026-10-21T00:00:00.000Z", "scheduled")
        ],
        // Every event carries its quoted evidence, as the real store does: history only admits events
        // the publisher actually evidenced.
        claims: [
            { eventKey: "lol/next-patch/26.20", field: "at", method: "ai", quote: "26.20 October 7, 2026", extractedAt: "2026-09-15T00:00:00.000Z" },
            { eventKey: "lol/next-patch/26.18", field: "at", method: "ai", quote: "26.18 September 9, 2026", extractedAt: "2026-09-15T00:00:00.000Z" },
            { eventKey: "lol/next-patch/26.17", field: "at", method: "ai", quote: "26.17 August 26, 2026", extractedAt: "2026-09-15T00:00:00.000Z" },
            { eventKey: "lol/next-patch/26.16", field: "at", method: "ai", quote: "26.16 August 12, 2026", extractedAt: "2026-09-15T00:00:00.000Z" }
        ],
        documents: []
    };
}

test("a game's blocks are exactly what its data supports", () => {
    // A published schedule is one sequence now, not a "Previously" list and an "Also scheduled" list
    // running in opposite directions either side of the headline. Every row either list carried is
    // still here, and the headline's own entry is marked rather than omitted.
    const blocks = blocksFor(lolKnowledge(), "next-patch", { format, now: NOW, currentKey: "lol/next-patch/26.19" });
    assert.deepEqual(blocks.map(b => b.title), ["Patch timeline"]);

    const timeline = blocks[0];
    assert.equal(timeline.shape, "timeline");
    assert.deepEqual(timeline.rows.map(r => r.label), ["26.16", "26.17", "26.18", "26.19", "26.20", "26.21"], "oldest first, reading down towards what is coming");
    assert.deepEqual(timeline.rows.map(r => r.state), ["released", "released", "released", "next", "scheduled", "scheduled"]);
    assert.equal(timeline.rows.find(r => r.label === "26.20")!.quote, "26.20 October 7, 2026", "a prose quote is shown");
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

test("computed occurrences never appear as archived publisher records", () => {
    // GTA's resets are generated by the rule adapter: no claim, no document, no archive to verify against.
    const reset = (day: string, status = "ended"): KnowledgeEvent => ({
        key: `gta/weekly-reset/${day}`, topic: "weekly-reset", kind: "recurring", label: "Weekly reset",
        status, at: `${day}T10:00:00.000Z`, precision: "exact", publishState: "published"
    });
    const gta: GameKnowledge = {
        events: [reset("2026-08-27"), reset("2026-09-03"), reset("2026-09-10"), reset("2026-09-17", "scheduled")],
        claims: [], documents: []
    };
    const blocks = blocksFor(gta, "weekly-reset", { format, now: NOW, currentKey: "gta/weekly-reset/2026-09-17" });
    assert.deepEqual(blocks.map(b => b.title), ["Then"], "three past resets do not become a verified history");
});

test("the newest claim describes the event, so a correction does not leave stale evidence beside it", () => {
    const corrected: GameKnowledge = {
        events: [
            patch("26.17", "2026-08-26T00:00:00.000Z"),
            patch("26.18", "2026-09-09T00:00:00.000Z"),
            patch("26.16", "2026-08-12T00:00:00.000Z")
        ],
        claims: [
            { eventKey: "lol/next-patch/26.18", field: "at", method: "ai", quote: "26.18 September 2, 2026", extractedAt: "2026-08-01T00:00:00.000Z", linkUrl: "https://example.com/old" },
            { eventKey: "lol/next-patch/26.18", field: "at", method: "ai", quote: "26.18 September 9, 2026", extractedAt: "2026-09-01T00:00:00.000Z", linkUrl: "https://example.com/corrected" },
            { eventKey: "lol/next-patch/26.17", field: "at", method: "ai", quote: "26.17 August 26, 2026", extractedAt: "2026-09-01T00:00:00.000Z" },
            { eventKey: "lol/next-patch/26.16", field: "at", method: "ai", quote: "26.16 August 12, 2026", extractedAt: "2026-09-01T00:00:00.000Z" }
        ],
        documents: []
    };
    const rows = blocksFor(corrected, "next-patch", { format, now: NOW })[0].rows;
    const row = rows.find(r => r.label === "26.18")!;
    assert.equal(row.quote, "26.18 September 9, 2026", "the corrected quote wins");
    assert.equal(row.href, "https://example.com/corrected");
});

test("a page that announces no date does not list upcoming dates underneath", () => {
    const options = { format, now: NOW, currentKey: "lol/next-patch/26.19" };
    const answered = blocksFor(lolKnowledge(), "next-patch", options)[0];
    assert.ok(answered.rows.some(r => r.state === "scheduled"), "an answered page shows what follows the answer");

    const unanswered = blocksFor(lolKnowledge(), "next-patch", { ...options, headlineAnswered: false })[0];
    assert.ok(unanswered.rows.every(r => r.state === "released" || r.state === "unconfirmed"),
        "no forward-looking row may contradict a headline that says no date is known");
    assert.ok(unanswered.rows.length >= MIN_HISTORY_ROWS, "what already happened is unaffected by a failed check");
});

test("evidence describes the date the event holds now, even after a correction was reverted", () => {
    // The original claim is content-addressed, so a reverted date does not re-append it with a fresh
    // timestamp: the intervening correction stays the newest claim while describing a date that is gone.
    const reverted: GameKnowledge = {
        events: [
            patch("26.18", "2026-09-09T00:00:00.000Z"),
            patch("26.17", "2026-08-26T00:00:00.000Z"),
            patch("26.16", "2026-08-12T00:00:00.000Z")
        ],
        claims: [
            { eventKey: "lol/next-patch/26.18", field: "at", value: "2026-09-09T00:00:00.000Z", method: "ai", quote: "26.18 September 9, 2026", extractedAt: "2026-08-01T00:00:00.000Z", linkUrl: "https://example.com/original" },
            { eventKey: "lol/next-patch/26.18", field: "at", value: "2026-09-16T00:00:00.000Z", method: "ai", quote: "26.18 September 16, 2026", extractedAt: "2026-09-05T00:00:00.000Z", linkUrl: "https://example.com/correction" },
            { eventKey: "lol/next-patch/26.17", field: "at", value: "2026-08-26T00:00:00.000Z", method: "ai", quote: "26.17 August 26, 2026", extractedAt: "2026-08-01T00:00:00.000Z" },
            { eventKey: "lol/next-patch/26.16", field: "at", value: "2026-08-12T00:00:00.000Z", method: "ai", quote: "26.16 August 12, 2026", extractedAt: "2026-08-01T00:00:00.000Z" }
        ],
        documents: []
    };
    const row = blocksFor(reverted, "next-patch", { format, now: NOW })[0].rows.find(r => r.label === "26.18")!;
    assert.equal(row.quote, "26.18 September 9, 2026", "the quote matches the date the event holds now");
    assert.equal(row.href, "https://example.com/original", "and so does the link");
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
    assert.deepEqual(
        regionalTimes("ends 2026-09-22 04:00 server time (Asia 20:00 UTC, Europe 03:00 UTC, America 09:00 UTC, dates vary)"),
        [],
        "when the regions fall on different UTC dates, times alone would mislead, so nothing is shown"
    );
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
            // A real knowledge file, because the renderer now validates one exactly as the pipeline does.
            const store = emptyKnowledge("lol", NOW) as unknown as { events: unknown[] };
            const event = (version: string, at: string) => ({
                key: `lol/next-patch/${version}`, game: "lol", topic: "next-patch", kind: "version",
                label: version, status: "scheduled", at, precision: "day", timezone: "UTC",
                firstSeen: "2026-01-01T00:00:00.000Z", lastVerified: NOW.toISOString(), publishState: "published"
            });
            store.events = [
                event("26.19", "2026-09-23T00:00:00.000Z"),
                event("26.20", "2026-10-07T00:00:00.000Z"),
                event("26.21", "2026-10-21T00:00:00.000Z")
            ];
            fs.mkdirSync(path.join(root, "knowledge", "games"), { recursive: true });
            fs.writeFileSync(path.join(root, "knowledge", "games", "lol.json"), JSON.stringify(store));
        }
        renderSite(dist, NOW, root);
        const html = fs.readFileSync(path.join(dist, "lol", "next-patch", "index.html"), "utf8");
        fs.rmSync(root, { recursive: true, force: true });
        return html;
    };

    const withStore = make(true);
    // This store holds only future patches — nothing behind the headline — so there is no sequence to
    // place yourself in and it stays the list it always was. A timeline needs both sides of now.
    assert.ok(withStore.includes("<h2>Also scheduled</h2>"), "the schedule is published");
    assert.ok(!withStore.includes(`class="timeline"`), "and a forward-only set is not drawn as a timeline");
    assert.ok(withStore.includes("26.20") && withStore.includes("26.21"));
    assert.ok(!withStore.includes(">26.19<"), "a list does not repeat the headline value");
    assert.ok(withStore.includes("September 23, 2026"), "and the headline value is still there");

    const withoutStore = make(false);
    assert.ok(withoutStore.includes(EMPTY_DATA_SLOT), "no store means an untouched, empty slot");
    assert.ok(withoutStore.includes("September 23, 2026"), "milestone 1 output is unaffected");
});

test("the knowledge store is optional", () => {
    assert.equal(loadKnowledge(os.tmpdir(), "definitely-not-a-game"), undefined);
});

test("a corrupt knowledge file costs a page its blocks, never the build", () => {
    const write = (contents: string) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-bad-"));
        fs.mkdirSync(path.join(root, "knowledge", "games"), { recursive: true });
        fs.writeFileSync(path.join(root, "knowledge", "games", "lol.json"), contents);
        return root;
    };

    // A file the pipeline's own loader would refuse must be refused here too, whole — not partly read.
    assert.equal(loadKnowledge(write('{"events":{},"claims":"nope"}'), "lol"), undefined, "wrong-shaped collections");
    assert.equal(loadKnowledge(write("not json at all"), "lol"), undefined);
    assert.equal(loadKnowledge(write("[]"), "lol"), undefined, "an array is not a knowledge file");
    assert.equal(loadKnowledge(write("null"), "lol"), undefined);

    const valid = emptyKnowledge("lol", NOW);
    assert.deepEqual(loadKnowledge(write(JSON.stringify(valid)), "lol")?.events, [], "a schema-valid file loads");

    assert.equal(loadKnowledge(write(JSON.stringify({ ...valid, schemaVersion: undefined })), "lol"), undefined, "missing schemaVersion is a schema violation");
    assert.equal(loadKnowledge(write(JSON.stringify(emptyKnowledge("cs2", NOW))), "lol"), undefined, "a file naming another game is not this game's knowledge");
    assert.equal(loadKnowledge(write(JSON.stringify({ ...valid, events: [{ key: "lol/next-patch/26.19", game: "lol", topic: "next-patch", kind: "version", label: "26.19", status: "scheduled", at: "2026-09-23T00:00:00.000Z", precision: "day", firstSeen: NOW.toISOString(), lastVerified: NOW.toISOString(), publishState: "nonsense" }] })), "lol"), undefined, "an event with an invalid publishState rejects the file");

    // And the page still publishes its value.
    const root = write('{"events":{}}');
    const dist = path.join(root, "dist");
    fs.mkdirSync(path.join(dist, "lol", "next-patch"), { recursive: true });
    fs.mkdirSync(path.join(dist, "data"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "public", "lol", "next-patch", "index.html"), path.join(dist, "lol", "next-patch", "index.html"));
    fs.writeFileSync(path.join(dist, "data", "lol.next-patch.json"), JSON.stringify({
        game: "lol", type: "next-patch", status: "fresh", nextEventUtc: "2026-09-23T00:00:00.000Z",
        fetched_at_utc: NOW.toISOString(), last_success_at_utc: NOW.toISOString(), precision: "day",
        source_url: "https://support.riotgames.com/x", confidence: "high", notes: "Patch 26.19"
    }));
    renderSite(dist, NOW, root);
    const html = fs.readFileSync(path.join(dist, "lol", "next-patch", "index.html"), "utf8");
    assert.ok(html.includes("September 23, 2026"), "the page is published with its value");
    assert.ok(html.includes(EMPTY_DATA_SLOT), "and simply without blocks");
});

test("history does not claim a release was confirmed when the evidence announced a plan", () => {
    // The evidence for a schedule shows the publisher announced a date, not that the release happened
    // on it. Whatever shape the block takes, its note may not claim more than that.
    const timeline = blocksFor(lolKnowledge(), "next-patch", { format, now: NOW, currentKey: "lol/next-patch/26.19" })[0];
    assert.ok(!/archive/i.test(timeline.note ?? ""), "a schedule page is not an archive of what shipped");
    assert.ok(!/confirmed|shipped|released on/i.test(timeline.note ?? ""), "and it does not claim the releases were confirmed");
    assert.equal(timeline.note, "Every date here was read from the official schedule. Dates after the next one can still change.");

    // An update feed, which really is a record of things that happened, keeps its own note.
    const feed: GameKnowledge = {
        game: "cs2",
        events: Array.from({ length: 4 }, (_, i) => ({
            key: `cs2/last-update/${i}`, topic: "last-update", kind: "occurrence", label: "Counter-Strike 2 Update",
            status: "observed", at: `2026-0${i + 1}-10T22:00:00.000Z`, precision: "exact", publishState: "published"
        })),
        claims: Array.from({ length: 4 }, (_, i) => ({ eventKey: `cs2/last-update/${i}`, field: "at", value: `2026-0${i + 1}-10T22:00:00.000Z`, linkUrl: `https://steam.test/${i}` })),
        documents: []
    };
    const updates = blocksFor(feed, "last-update", { format, now: NOW }).find(b => b.title === "Previously");
    assert.ok(updates, "an update feed still gets its list");
    assert.equal(updates!.note, "Each of these dates came from the official source at the time.");
});

// === V4 PR 6: each game gets the shape its data supports ===

/** A version-kind schedule: what League of Legends publishes — a year of patches, past and future. */
function versionSchedule(): GameKnowledge {
    const events: KnowledgeEvent[] = [
        ["26.16", "2026-08-12", "observed"],
        ["26.17", "2026-08-26", "observed"],
        ["26.18", "2026-09-10", "observed"],
        ["26.19", "2026-09-23", "scheduled"],
        ["26.20", "2026-10-07", "scheduled"],
        ["26.21", "2026-10-21", "scheduled"],
        ["26.22", "2026-11-04", "scheduled"]
    ].map(([label, day, status]) => ({
        key: `lol/next-patch/${label}`,
        topic: "next-patch",
        kind: "version",
        label: label as string,
        status: status as string,
        at: `${day}T00:00:00.000Z`,
        precision: "day",
        publishState: "published"
    }));
    return {
        game: "lol",
        events,
        claims: events.map(event => ({
            eventKey: event.key,
            field: "at",
            value: event.at,
            method: "ai",
            quote: `${event.label} ${event.at!.slice(0, 10)}`,
            linkUrl: "https://support.riotgames.com/schedule",
            extractedAt: "2026-09-01T00:00:00.000Z"
        })),
        documents: []
    };
}

const TIMELINE_NOW = new Date("2026-09-16T12:00:00Z");
const readable = (iso: string, precision?: string) => (precision === "exact" ? formatDateTime(iso) : formatDate(iso));

test("a published schedule is one sequence, oldest to newest, with the next entry marked", () => {
    const blocks = blocksFor(versionSchedule(), "next-patch", {
        format: readable,
        now: TIMELINE_NOW,
        currentKey: "lol/next-patch/26.19",
        headlineAnswered: true
    });
    assert.equal(blocks.length, 1, "one timeline instead of two lists running in opposite directions");
    const timeline = blocks[0];
    assert.equal(timeline.shape, "timeline");
    assert.equal(timeline.title, "Patch timeline");

    const labels = timeline.rows.map(row => row.label);
    assert.deepEqual(labels, ["26.16", "26.17", "26.18", "26.19", "26.20", "26.21", "26.22"]);
    // Oldest first: the reader reads down towards what is coming.
    assert.deepEqual(timeline.rows.map(row => row.state), [
        "released", "released", "released", "next", "scheduled", "scheduled", "scheduled"
    ]);
    assert.equal(timeline.rows.find(row => row.state === "next")!.label, "26.19");
});

test("every timeline row keeps the evidence its list rows had", () => {
    const timeline = blocksFor(versionSchedule(), "next-patch", {
        format: readable, now: TIMELINE_NOW, currentKey: "lol/next-patch/26.19", headlineAnswered: true
    })[0];
    for (const row of timeline.rows) {
        assert.equal(row.href, "https://support.riotgames.com/schedule", `${row.label} lost its official link`);
        assert.ok(row.quote && row.quote.includes(row.label), `${row.label} lost its verbatim quote`);
        assert.ok(row.when.length > 0);
    }
    // A date-only schedule is still dates, all the way down.
    assert.equal(timeline.rows.find(row => row.label === "26.19")!.when, "September 23, 2026");
    assert.ok(!timeline.rows.some(row => row.when.includes("00:00")), "midnight is never published as a time");
});

test("a page that cannot answer its question lists nothing after the answer it does not have", () => {
    const blocks = blocksFor(versionSchedule(), "next-patch", {
        format: readable, now: TIMELINE_NOW, currentKey: "lol/next-patch/26.19", headlineAnswered: false
    });
    const timeline = blocks[0];
    assert.ok(timeline.rows.every(row => row.state === "released"), "only what already happened");
    assert.ok(!timeline.rows.some(row => row.state === "next" || row.state === "scheduled"));
    // What already happened is unaffected by today's failed check, so it is still shown.
    assert.ok(timeline.rows.length >= 2);
});

test("an update feed is a list, not a timeline, however many rows it has", () => {
    // Nineteen Counter-Strike updates, all in the past, none scheduled. Rendering them on a rail with
    // "Next" markers would imply a cadence Valve does not publish.
    const events: KnowledgeEvent[] = Array.from({ length: 6 }, (_, i) => ({
        key: `cs2/last-update/${i}`,
        topic: "last-update",
        kind: "occurrence",
        label: "Counter-Strike 2 Update",
        status: "observed",
        at: `2026-0${i + 1}-10T22:00:00.000Z`,
        precision: "exact",
        publishState: "published"
    }));
    const knowledge: GameKnowledge = {
        game: "cs2",
        events,
        claims: events.map(e => ({ eventKey: e.key, field: "at", value: e.at, linkUrl: "https://steam.test/" + e.key, extractedAt: "2026-09-01T00:00:00.000Z" })),
        documents: []
    };
    assert.equal(timelineFor(knowledge, "last-update", { format: readable, now: TIMELINE_NOW }), undefined);
    const blocks = blocksFor(knowledge, "last-update", { format: readable, now: TIMELINE_NOW, headlineAnswered: true });
    assert.deepEqual(blocks.map(b => b.title), ["Previously"]);
    assert.equal(blocks[0].shape, undefined, "a list stays a list");
});

test("a recurring rule is projected, and says it was computed rather than read", () => {
    const knowledge: GameKnowledge = {
        game: "gta",
        events: [{
            key: "gta/weekly-reset/2026-09-17", topic: "weekly-reset", kind: "recurring", label: "Weekly reset",
            status: "scheduled", at: "2026-09-17T10:00:00.000Z", precision: "exact", publishState: "published"
        }],
        claims: [],
        documents: []
    };
    assert.equal(timelineFor(knowledge, "weekly-reset", { format: readable, now: TIMELINE_NOW }), undefined, "a rule is not a schedule of versions");
    const blocks = blocksFor(knowledge, "weekly-reset", { format: readable, now: TIMELINE_NOW, currentKey: "gta/weekly-reset/2026-09-17", headlineAnswered: true });
    assert.deepEqual(blocks.map(b => b.title), ["Then"]);
    assert.match(blocks[0].note!, /Computed/, "a projection says it is one");
    assert.equal(blocks[0].rows.length, 4);
});

test("a single status observation supports no block at all", () => {
    // Roblox's store holds one observation. An empty heading would be worse than no section, and a
    // one-row "history" is not a history.
    const knowledge: GameKnowledge = {
        game: "roblox",
        events: [{
            key: "roblox/status/2026-08-07", topic: "status", kind: "occurrence", label: "Operational",
            status: "observed", at: "2026-08-07T04:48:28.252Z", precision: "exact", publishState: "published"
        }],
        claims: [],
        documents: []
    };
    assert.equal(timelineFor(knowledge, "status", { format: readable, now: TIMELINE_NOW }), undefined);
    assert.deepEqual(blocksFor(knowledge, "status", { format: readable, now: TIMELINE_NOW, headlineAnswered: true }), []);
});

test("a timeline of one entry is not a timeline", () => {
    const knowledge = versionSchedule();
    knowledge.events = knowledge.events!.slice(0, 1);
    assert.equal(timelineFor(knowledge, "next-patch", { format: readable, now: TIMELINE_NOW }), undefined);
});

test("the timeline shows everything the two lists it replaces showed", () => {
    const knowledge = versionSchedule();
    // A full year of fortnightly patches, which is what the store actually holds for League of Legends.
    knowledge.events = Array.from({ length: 26 }, (_, i) => ({
        key: `lol/next-patch/26.${String(i + 1).padStart(2, "0")}`,
        topic: "next-patch",
        kind: "version",
        label: `26.${String(i + 1).padStart(2, "0")}`,
        status: i < 18 ? "observed" : "scheduled",
        at: new Date(Date.UTC(2026, 0, 8 + i * 14)).toISOString(),
        precision: "day",
        publishState: "published"
    }));
    const timeline = timelineFor(knowledge, "next-patch", { format: readable, now: TIMELINE_NOW, headlineAnswered: true })!;
    // The caps are the ones "Previously" and "Also scheduled" already used, so changing shape cannot
    // cost the page a single verified row. A shorter window dropped eight of League of Legends' twelve
    // published patches, which is content loss dressed as a redesign.
    assert.ok(timeline.rows.length <= MIN_HISTORY_ROWS + MAX_HISTORY_ROWS * 2, `${timeline.rows.length} rows`);
    const released = timeline.rows.filter(r => r.state === "released").length;
    assert.ok(released >= 12, `expected the full published history, got ${released} released rows`);
    assert.ok(timeline.rows.some(row => row.state !== "released"), "and it still reaches what is coming");
});

test("timeline markup carries the state as a word, not only as a colour", () => {
    const timeline = blocksFor(versionSchedule(), "next-patch", {
        format: readable, now: TIMELINE_NOW, currentKey: "lol/next-patch/26.19", headlineAnswered: true
    })[0];
    const html = renderBlocks([timeline]);
    assert.match(html, /<ul class="timeline">/);
    assert.match(html, /class="event is-next"/);
    assert.match(html, /<span class="event-state">Next<\/span>/);
    assert.match(html, /<span class="event-state">Released<\/span>/);
    assert.match(html, /<span class="event-state">Scheduled<\/span>/);
    // Still one heading, still the official links, still the quotes.
    assert.equal((html.match(/<h2>/g) ?? []).length, 1);
    assert.ok(html.includes('rel="noopener"'));
    assert.ok(html.includes('class="data-quote"'));
});

test("a held event never reaches a timeline", () => {
    const knowledge = versionSchedule();
    knowledge.events![3].publishState = "held";
    const timeline = timelineFor(knowledge, "next-patch", { format: readable, now: TIMELINE_NOW, headlineAnswered: true })!;
    assert.ok(!timeline.rows.some(row => row.label === "26.19"), "ours to know, not to publish");
});

test("data from the store cannot inject markup into a timeline", () => {
    const knowledge = versionSchedule();
    knowledge.events![3].label = '26.19"><script>alert(1)</script>';
    knowledge.claims![3].linkUrl = 'javascript:alert(1)"';
    const html = renderBlocks([timelineFor(knowledge, "next-patch", { format: readable, now: TIMELINE_NOW, headlineAnswered: true })!]);
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes('javascript:alert(1)"'), "the href is escaped");
    assert.ok(html.includes("&lt;script&gt;"));
});

// === Codex review of #51 ===

test("a date that merely passed is not called Released", () => {
    // Codex P2 on #51. The pipeline turns a scheduled event into "ended" when its date goes by
    // (knowledge.ts), whether or not the patch shipped: delayed, cancelled, or a refresh that failed all
    // look the same. Only an observed release supports the word "Released".
    const knowledge = lolKnowledge();
    const at = (knowledge.events ?? []).find(e => e.key === "lol/next-patch/26.18")!;
    at.status = "ended";
    const timeline = blocksFor(knowledge, "next-patch", { format, now: NOW, currentKey: "lol/next-patch/26.19" })[0];
    const row = timeline.rows.find(r => r.label.includes("26.18"))!;
    assert.equal(row.state, "unconfirmed");
    assert.ok(timeline.rows.filter(r => r.label.includes("26.17") || r.label.includes("26.16")).every(r => r.state === "released"),
        "the observed releases around it are still Released");
    const html = renderBlocks([timeline]);
    assert.match(html, /is-unconfirmed[\s\S]*Not confirmed/, "and the page says so in words");
});

test("an update feed with a release stamped slightly after now stays a list", () => {
    // Codex P2 on #51. selectCurrentEvent deliberately lets an observed event sit a little ahead of now
    // (source clock skew, or a change that landed mid-request). A timestamp alone must not turn that
    // feed into a timeline and present an already-shipped release as "Next".
    const feed: GameKnowledge = {
        game: "pubg",
        events: [
            ...["2026-08-12", "2026-08-26", "2026-09-09"].map((day, i) => ({
                key: `pubg/last-patch/${i}`, topic: "last-patch", kind: "version" as const, label: `Update ${i + 40}`,
                status: "observed" as const, at: `${day}T02:00:00.000Z`, precision: "exact" as const, publishState: "published" as const
            })),
            {
                key: "pubg/last-patch/3", topic: "last-patch", kind: "version" as const, label: "Update 43",
                status: "observed" as const, at: new Date(NOW.getTime() + 90 * 1000).toISOString(), precision: "exact" as const, publishState: "published" as const
            }
        ],
        claims: [0, 1, 2, 3].map(i => ({ eventKey: `pubg/last-patch/${i}`, field: "at", value: "x", linkUrl: `https://steam.test/${i}` })),
        documents: []
    } as unknown as GameKnowledge;
    assert.equal(timelineFor(feed, "last-patch", { format, now: NOW }), undefined, "a feed became a timeline");
});

test("a real schedule is still a timeline", () => {
    const timeline = timelineFor(lolKnowledge(), "next-patch", { format, now: NOW, currentKey: "lol/next-patch/26.19" });
    assert.ok(timeline, "LoL's announced schedule must still read as one sequence");
    assert.equal(timeline!.shape, "timeline");
});

