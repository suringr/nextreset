/**
 * Whether a degraded run can be seen.
 *
 * The alarm this replaces could not see the thing it was built for. `refresh-all` exits non-zero only
 * when more than half of all providers are unavailable, and a *stale* provider never counts at all — so
 * Fortnite serving last-known-good data from 2026-04-05 for six months left every single run green
 * (Codex, #69). These tests are mostly about that one case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RefreshHealth, unexpectedlyDegraded } from "../../refresh-health";
import { EDITORIAL_NOINDEX } from "../../indexing";
import { trackerPages } from "../../site-map";

const health = (providers: RefreshHealth["providers"]): RefreshHealth => ({ at: "2026-10-11T00:00:00.000Z", providers });

/** A tracker whose page is in the index, taken from the manifest rather than hard-coded. */
const indexed = trackerPages().find(entry => !EDITORIAL_NOINDEX.some(x => x.page === entry.page))!.tracker!;
/** A tracker whose page is editorially withheld — a stop someone has already written down. */
const withheld = trackerPages().find(entry => EDITORIAL_NOINDEX.some(x => x.page === entry.page))!.tracker!;

test("a fresh run has nothing to report", () => {
    assert.deepEqual(unexpectedlyDegraded(health([
        { game: indexed.game, type: indexed.type, status: "fresh" },
        { game: withheld.game, type: withheld.type, status: "fresh" }
    ])), []);
});

test("a stale provider whose page is still in the index is news", () => {
    // The case the exit code cannot see: one provider, stale rather than unavailable, nowhere near a
    // majority. Exactly what went unnoticed for six months.
    const degraded = unexpectedlyDegraded(health([
        { game: indexed.game, type: indexed.type, status: "stale", detail: "source unreachable" }
    ]));
    assert.deepEqual(degraded.map(p => `${p.game}/${p.type}`), [`${indexed.game}/${indexed.type}`]);
});

test("a stop someone has already written down does not hold the run red", () => {
    // Fortnite is unreachable and is expected to be. Counting it would mean a permanently red run, and
    // an alarm that is always on is one nobody reads — so the next real regression would be invisible.
    assert.deepEqual(unexpectedlyDegraded(health([
        { game: withheld.game, type: withheld.type, status: "stale", detail: "403" }
    ])), []);
});

test("an accepted stop does not hide an unaccepted one in the same run", () => {
    const degraded = unexpectedlyDegraded(health([
        { game: withheld.game, type: withheld.type, status: "stale", detail: "403" },
        { game: indexed.game, type: indexed.type, status: "unavailable", detail: "no data" }
    ]));
    assert.deepEqual(degraded.map(p => p.game), [indexed.game]);
});

test("a provider the manifest does not know about counts", () => {
    // No page means no editorial decision behind it, so nobody has accepted anything.
    assert.equal(unexpectedlyDegraded(health([
        { game: "not-a-game", type: "not-a-topic", status: "unavailable" }
    ])).length, 1);
});
