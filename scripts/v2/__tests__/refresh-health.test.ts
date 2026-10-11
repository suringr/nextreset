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
import { ACCEPTED_OUTAGES, RefreshHealth, acceptedOutage, unexpectedlyDegraded } from "../../refresh-health";
import { EDITORIAL_NOINDEX } from "../../indexing";
import { trackerPages } from "../../site-map";

const health = (providers: RefreshHealth["providers"]): RefreshHealth => ({ at: "2026-10-11T00:00:00.000Z", providers });
const accepted = ACCEPTED_OUTAGES[0];

test("a stale provider nobody has accepted is news", () => {
    // The case the exit code cannot see: one provider, stale rather than unavailable, nowhere near a
    // majority. Exactly what went unnoticed for six months.
    const degraded = unexpectedlyDegraded(health([{ game: "lol", type: "next-patch", status: "stale", detail: "source unreachable" }]));
    assert.deepEqual(degraded.map(p => `${p.game}/${p.type}`), ["lol/next-patch"]);
});

test("an accepted outage does not hold the run red", () => {
    // Fortnite is unreachable and is expected to be. Counting it would mean a permanently red run, and
    // an alarm that is always on is one nobody reads — so the next real regression would be invisible.
    assert.deepEqual(unexpectedlyDegraded(health([
        { game: accepted.game, type: accepted.type, status: "stale", detail: "403" }
    ])), []);
});

test("a page withheld from the index is not thereby an accepted outage", () => {
    // The distinction the first version of this got wrong. Every editorially withheld tracker that is
    // not on the accepted list must still report, because it was withheld for a reason about the page
    // rather than a reason about the provider.
    const withheldButWorking = EDITORIAL_NOINDEX
        .map(entry => trackerPages().find(page => page.page === entry.page)?.tracker)
        .filter((tracker): tracker is NonNullable<typeof tracker> => tracker !== undefined)
        .filter(tracker => acceptedOutage(tracker.game, tracker.type) === undefined);
    assert.ok(withheldButWorking.length > 0, "no withheld-but-not-accepted tracker to check — this guard is checking nothing");

    for (const tracker of withheldButWorking) {
        const degraded = unexpectedlyDegraded(health([{ game: tracker.game, type: tracker.type, status: "unavailable" }]));
        assert.equal(degraded.length, 1, `${tracker.game}/${tracker.type} is withheld from the index, and its failure was treated as expected`);
    }
});

test("an accepted outage does not hide an unaccepted one in the same run", () => {
    const degraded = unexpectedlyDegraded(health([
        { game: accepted.game, type: accepted.type, status: "stale", detail: "403" },
        { game: "cs2", type: "last-update", status: "unavailable", detail: "no data" }
    ]));
    assert.deepEqual(degraded.map(p => p.game), ["cs2"]);
});

test("a fresh run has nothing to report", () => {
    assert.deepEqual(unexpectedlyDegraded(health([
        { game: "lol", type: "next-patch", status: "fresh" },
        { game: accepted.game, type: accepted.type, status: "fresh" }
    ])), []);
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
