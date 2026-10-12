/**
 * Whether a degraded run can be seen, and whether the right degradation is the one that shows.
 *
 * The alarm this replaces could not see the thing it was built for: `refresh-all` exits non-zero only
 * when more than half of all providers are unavailable, and a *stale* provider never counts at all — so
 * Fortnite serving last-known-good data from 2026-04-05 for six months left every run green.
 *
 * The first fix then silenced too much. It keyed on `EDITORIAL_NOINDEX`, reusing a decision about
 * indexing to mean "this outage is expected". Those coincide for Fortnite and nowhere else — Roblox is
 * withheld because a service status is not a reset, and its provider works — so a real Roblox regression
 * would have gone unreported indefinitely (Codex, #69). Both halves are tested here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { ACCEPTED_OUTAGES, RefreshHealth, acceptedOutage, escapeAnnotation, unexpectedlyDegraded } from "../../refresh-health";
import { EDITORIAL_NOINDEX } from "../../indexing";
import { trackerPages } from "../../site-map";

const health = (providers: RefreshHealth["providers"]): RefreshHealth => ({ at: "2026-10-11T00:00:00.000Z", providers });
const accepted = ACCEPTED_OUTAGES[0];
/** Inside every acceptance window in the list, so the date is never the reason a test passes. */
const NOW = new Date("2026-10-12T00:00:00.000Z");

test("a stale provider nobody has accepted is news", () => {
    // The case the exit code cannot see: one provider, stale rather than unavailable, nowhere near a
    // majority. Exactly what went unnoticed for six months.
    const degraded = unexpectedlyDegraded(health([{ game: "lol", type: "next-patch", status: "stale", detail: "source unreachable" }]), NOW);
    assert.deepEqual(degraded.map(p => `${p.game}/${p.type}`), ["lol/next-patch"]);
});

test("an accepted outage does not hold the run red", () => {
    // Fortnite is unreachable and is expected to be. Counting it would mean a permanently red run, and
    // an alarm that is always on is one nobody reads — so the next real regression would be invisible.
    assert.deepEqual(unexpectedlyDegraded(health([
        { game: accepted.game, type: accepted.type, status: "stale", detail: "403" }
    ]), NOW), []);
});

test("a page withheld from the index is not thereby an accepted outage", () => {
    // The distinction the first version of this got wrong. Every editorially withheld tracker that is
    // not on the accepted list must still report, because it was withheld for a reason about the page
    // rather than a reason about the provider.
    const withheldButWorking = EDITORIAL_NOINDEX
        .map(entry => trackerPages().find(page => page.page === entry.page)?.tracker)
        .filter((tracker): tracker is NonNullable<typeof tracker> => tracker !== undefined)
        .filter(tracker => acceptedOutage(tracker.game, tracker.type, "unavailable", NOW) === undefined);
    assert.ok(withheldButWorking.length > 0, "no withheld-but-not-accepted tracker to check — this guard is checking nothing");

    for (const tracker of withheldButWorking) {
        const degraded = unexpectedlyDegraded(health([{ game: tracker.game, type: tracker.type, status: "unavailable" }]), NOW);
        assert.equal(degraded.length, 1, `${tracker.game}/${tracker.type} is withheld from the index, and its failure was treated as expected`);
    }
});

test("an accepted outage does not hide an unaccepted one in the same run", () => {
    const degraded = unexpectedlyDegraded(health([
        { game: accepted.game, type: accepted.type, status: "stale", detail: "403" },
        { game: "cs2", type: "last-update", status: "unavailable", detail: "no data" }
    ]), NOW);
    assert.deepEqual(degraded.map(p => p.game), ["cs2"]);
});

test("a fresh run has nothing to report", () => {
    assert.deepEqual(unexpectedlyDegraded(health([
        { game: "lol", type: "next-patch", status: "fresh" },
        { game: accepted.game, type: accepted.type, status: "fresh" }
    ]), NOW), []);
});

test("every accepted outage says why and since when", () => {
    // It is a list that silences an alarm. Whoever reads it next needs to be able to judge whether the
    // entry is still true, and a bare game id does not let them.
    for (const entry of ACCEPTED_OUTAGES) {
        assert.ok(entry.reason.trim().length > 0, `${entry.game}/${entry.type} is accepted with no reason`);
        assert.match(entry.since, /^\d{4}-\d{2}-\d{2}$/, `${entry.game}/${entry.type} has no date`);
        assert.ok(trackerPages().some(page => page.tracker?.game === entry.game && page.tracker?.type === entry.type),
            `${entry.game}/${entry.type} is accepted but is not a tracker this site publishes`);
    }
});

test("an acceptance lapses, so a silence has to be renewed rather than inherited", () => {
    // An entry with no end date silences a tracker for ever, and `since` could not make that visible
    // because nothing read it (Codex, #69). After the date it reports again until somebody looks.
    const after = new Date(Date.parse(accepted.until) + 86_400_000);
    const stale = health([{ game: accepted.game, type: accepted.type, status: accepted.expect }]);

    assert.deepEqual(unexpectedlyDegraded(stale, NOW), [], "the acceptance is not silencing inside its window");
    assert.equal(unexpectedlyDegraded(stale, after).length, 1,
        "the acceptance outlived its own end date and kept the alarm off");
});

test("an acceptance covers the failure it was written for, and not a different one", () => {
    // Fortnite is accepted as stale: a source answering 403 while the store still holds a value. A
    // provider that went unavailable is failing in a way nobody has looked at and should say so rather
    // than inherit the silence.
    const other: typeof accepted.expect = accepted.expect === "stale" ? "unavailable" : "stale";
    assert.deepEqual(unexpectedlyDegraded(health([{ game: accepted.game, type: accepted.type, status: accepted.expect }]), NOW), []);
    assert.equal(unexpectedlyDegraded(health([{ game: accepted.game, type: accepted.type, status: other }]), NOW).length, 1,
        `a ${other} failure inherited the silence written for a ${accepted.expect} one`);
});

test("every accepted outage carries an end date in the future of its start", () => {
    for (const entry of ACCEPTED_OUTAGES) {
        assert.match(entry.until, /^\d{4}-\d{2}-\d{2}$/, `${entry.game}/${entry.type} has no end date`);
        assert.ok(Date.parse(entry.until) > Date.parse(entry.since),
            `${entry.game}/${entry.type} lapses before it begins`);
    }
});

test("a provider's own words cannot forge a workflow command", () => {
    // The runner reads `::warning ...` out of a step's output, so a reason string ends up inside a
    // control line. A newline truncates the annotation; a line beginning `::` is read as another command
    // (Codex, #69).
    const hostile = "timed out\n::error::this did not happen\n::stop-commands::x";
    const safe = escapeAnnotation(hostile);
    assert.ok(!safe.includes("\n"), "a newline survives into the annotation");
    assert.ok(!safe.includes("\r"), "a carriage return survives into the annotation");
    assert.ok(safe.includes("%0A"), "the newline was dropped rather than escaped");
    assert.equal(escapeAnnotation("100% done"), "100%25 done", "a bare percent is not escaped");
});

test("nothing in the publish path imports the refresher", () => {
    // refresh-all.ts calls main() at module load. Importing anything from it — I did, for one shared
    // helper — starts a full data refresh as a side effect of the import. In the publish step that
    // would have been a second refresh per run: every provider fetched twice, on the schedule, for ever.
    //
    // It cost nothing to find because the proof was in the output: the report printed "Fetching
    // https://www.fortnite.com/battle-pass" where it should have printed one line.
    const root = path.resolve(__dirname, "..", "..", "..", "scripts");
    for (const file of ["refresh-health.ts", "refresh-health-report.ts", "publish-gate.ts"]) {
        const source = fs.readFileSync(path.join(root, file), "utf8");
        assert.ok(!/from "\.\/refresh-all"/.test(source),
            `${file} imports refresh-all, which runs a data refresh when it is loaded`);
    }
});
