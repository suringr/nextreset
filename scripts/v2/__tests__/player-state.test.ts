/**
 * V4, PR 3: one versioned record, and nothing it can do breaks the site.
 *
 * The prototype kept two unrelated keys and they had already drifted: the homepage read a rank from
 * `nrScopeV3` that the game never wrote, so BEST RANK was permanently "C". This suite exists so the
 * single record cannot repeat that, and so the three rules hold under the conditions a real browser
 * actually produces — private mode, a full quota, storage switched off, and a record written by a
 * version of the site that does not exist yet.
 *
 * Since ONE SHOT the record is version 2: it holds the game's progress (XP, the contracts unlocked, the
 * stars on each), carries RESET//SCOPE's records untouched for a rollback, and tracking earns nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { gamePages } from "../../update-game-pages";
import { ONE_SHOT_CONTRACTS, ONE_SHOT_RANKS, ONE_SHOT_RANK_XP } from "../../design/one-shot";

const ROOT = path.join(__dirname, "..", "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "public", "assets", "player.js"), "utf8");

/** How a browser's localStorage behaves, including the ways it refuses. */
class FakeStorage {
    items = new Map<string, string>();
    failWrites = false;
    failReads = false;
    writes = 0;

    getItem(key: string): string | null {
        if (this.failReads) throw new Error("SecurityError: storage is no longer accessible");
        return this.items.has(key) ? this.items.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        if (this.failWrites) {
            const error: Error & { name: string } = new Error("QuotaExceededError") as never;
            error.name = "QuotaExceededError";
            throw error;
        }
        // The availability probe is not a write anyone asked for; counting it would measure the
        // wrong thing in the test that checks a quiet load stays quiet.
        if (key !== "__nr_probe__") this.writes++;
        this.items.set(key, value);
    }
    removeItem(key: string): void {
        this.items.delete(key);
    }
}

interface OneShot {
    contracts: number;
    unlocked: number;
    stars: number[];
    starsTotal: number;
    cleared: number;
    bestScore: number;
    xp: number;
    rank: string;
}

interface Player {
    KEY: string;
    VERSION: number;
    GAME_IDS: string[];
    CONTRACTS: number;
    RANKS: string[];
    RANK_XP: number;
    LEGACY_KEYS: { tracked: string };
    defaults(): Record<string, unknown>;
    load(): Record<string, unknown>;
    save(state: unknown): boolean;
    forget(): void;
    refresh(): void;
    toGameId(value: unknown): string | null;
    trackedGames(): string[];
    isTracked(game: string): boolean;
    track(game: string): boolean;
    untrack(game: string): boolean;
    toggleTracked(game: string): boolean;
    oneShot(): OneShot;
    recordContract(contract: unknown, points: unknown, stars: unknown): boolean;
    recordFinish(score: unknown): boolean;
    rankFor(xp: number): string;
    profile(): { xp: number; rank: string };
    chipText(): string | null;
    storageAvailable(): boolean;
}

/**
 * A fresh page load, with whatever is already in storage. `storage: null` means it is switched off.
 *
 * Evaluated in this realm rather than a vm context, because a vm gives the script its own Array and
 * Object prototypes and every deepEqual against what it returns then fails on identity rather than on
 * content. Passing a `document` makes the file take its browser path, so these tests exercise the
 * migration that really happens on load rather than a version of it arranged for the test.
 */
function boot(seed: Record<string, unknown> = {}, storage: FakeStorage | null = new FakeStorage()): { player: Player; storage: FakeStorage | null } {
    if (storage) {
        for (const [key, value] of Object.entries(seed)) {
            storage.items.set(key, typeof value === "string" ? value : JSON.stringify(value));
        }
    }
    const window: Record<string, unknown> = {};
    if (storage) window.localStorage = storage;
    // eslint-disable-next-line no-new-func
    const evaluate = new Function("window", "document", SOURCE) as (w: unknown, d: unknown) => void;
    evaluate(window, {});
    return { player: window.NextResetPlayer as Player, storage };
}

const KEY = "nextreset.player.v1";

/** A visitor's record as version 1 of this file wrote it: RESET//SCOPE's records, levels, achievements. */
const VERSION_ONE = {
    version: 1, profile: { xp: 320, level: 3, awarded: ["first-track"] }, games: { tracked: ["lol", "gta"] },
    arcade: { resetScope: { highScore: 5000, highestMission: 2, bestCombo: 4, bestRank: "C", gamesPlayed: 2 } },
    achievements: ["first-run"]
};

function stored(storage: FakeStorage): Record<string, any> {
    return JSON.parse(storage.items.get(KEY)!);
}

test("the twelve ids are the twelve games the site publishes", () => {
    // A game added to the site but not here would be untrackable, and nothing else would say so.
    const { player } = boot();
    assert.deepEqual(player.GAME_IDS.slice().sort(), gamePages.map(page => page.game).sort());
    assert.equal(player.GAME_IDS.length, 12);
});

test("a first visit starts at the defaults and writes them once", () => {
    const { player, storage } = boot();
    const state = player.load() as { version: number; profile: { xp: number }; games: { tracked: string[] } };
    assert.equal(state.version, 2);
    assert.deepEqual(state.games.tracked, []);
    assert.equal(state.profile.xp, 0);
    const shot = player.oneShot();
    assert.equal(shot.unlocked, 1, "the game starts at contract 1");
    assert.equal(shot.stars.length, 80);
    assert.ok(shot.stars.every(n => n === 0));
    assert.equal(shot.bestScore, 0);
    assert.equal(shot.rank, "Recruit");
    assert.ok(storage!.items.has(KEY));
    assert.equal(stored(storage!).arcade.resetScope, undefined, "a new visitor carries nothing from RESET//SCOPE");
});

test("the prototype's tracked names become ids, and the old key is left alone", () => {
    const { player, storage } = boot({ nrTracked: ["Genshin", "LoL", "GTA Online", "Fortnite"] });
    assert.deepEqual(player.trackedGames(), ["genshin", "lol", "gta", "fortnite"]);
    assert.equal(storage!.getItem("nrTracked"), JSON.stringify(["Genshin", "LoL", "GTA Online", "Fortnite"]),
        "the legacy key is read, never deleted: another tab may still be using it");
});

test("migration only ever adds, so it is safe to run again", () => {
    const storage = new FakeStorage();
    storage.items.set("nrTracked", JSON.stringify(["LoL"]));

    const first = boot({}, storage).player;
    first.track("cs2");
    first.recordContract(1, 1200, 3);

    // A second page load re-reads the legacy key, which is still there.
    const second = boot({}, storage).player;
    assert.deepEqual(second.trackedGames().sort(), ["cs2", "lol"], "nothing tracked in the new key was lost");
    assert.equal(second.oneShot().xp, 1200, "and a re-read is not a clear");
    assert.equal(second.oneShot().unlocked, 2);
});

test("a game the site does not track is not stored", () => {
    const { player } = boot({ nrTracked: ["Genshin", "Halo", "", null, 7, "lol"] });
    assert.deepEqual(player.trackedGames(), ["genshin", "lol"]);
    assert.equal(player.track("halo"), false);
    assert.equal(player.toGameId("Counter-Strike 2"), "cs2");
    assert.equal(player.toGameId("Red Dead Redemption 2"), "red-dead-redemption-2");
    assert.equal(player.toGameId("nothing"), null);
    assert.equal(player.toGameId(undefined), null);
});

test("corrupt storage is a fresh start, not a crash", () => {
    for (const junk of ["not json at all", "[]", "null", '"a string"', "42", '{"games":{"tracked":"lol"}}']) {
        const { player } = boot({ [KEY]: junk });
        assert.doesNotThrow(() => player.load());
        assert.deepEqual(player.trackedGames(), [], `survived ${junk}`);
        assert.equal(player.profile().xp, 0);
        assert.equal(player.oneShot().unlocked, 1);
    }
});

test("values of the wrong type are clamped rather than trusted", () => {
    const { player } = boot({
        [KEY]: {
            version: 2,
            profile: { xp: -5000, rank: "Master Sniper" },
            games: { tracked: ["lol", "lol", "lol"] },
            arcade: { oneShot: { unlocked: 999, stars: [3, 9, -1, "2", null, 2.7], bestScore: "abc" } }
        }
    });
    assert.equal(player.profile().xp, 0, "negative XP is no XP");
    assert.equal(player.profile().rank, "Recruit", "the rank is derived from XP, never read from storage");
    assert.deepEqual(player.trackedGames(), ["lol"], "a duplicate is stored once");
    const shot = player.oneShot();
    assert.equal(shot.unlocked, 80, "clamped to the last contract");
    assert.deepEqual(shot.stars.slice(0, 6), [3, 3, 0, 2, 0, 2], "0 to 3 stars, whole, per contract");
    assert.equal(shot.stars.length, 80);
    assert.equal(shot.bestScore, 0);

    for (const unlocked of [0, -3, "x", null]) {
        const again = boot({ [KEY]: { version: 2, arcade: { oneShot: { unlocked } } } }).player;
        assert.equal(again.oneShot().unlocked, 1, `unlocked ${String(unlocked)} is contract 1`);
    }
});

test("storage switched off leaves a working site", () => {
    const { player } = boot({}, null);
    assert.equal(player.storageAvailable(), false);
    assert.doesNotThrow(() => player.load());
    assert.equal(player.track("lol"), true, "the call still reports what it did");
    assert.deepEqual(player.trackedGames(), ["lol"], "and the session remembers it in memory");
    assert.equal(player.save(player.load()), false, "it just never reaches storage");
    assert.doesNotThrow(() => player.recordContract(1, 900, 2));
    assert.equal(player.oneShot().xp, 900, "a clear still counts for the rest of the page");
    assert.doesNotThrow(() => player.recordFinish(40000));
});

test("a full quota is not a crash either", () => {
    const storage = new FakeStorage();
    const { player } = boot({}, storage);
    // Storage was fine when the page loaded and fills up afterwards, which is the realistic order.
    storage.failWrites = true;
    assert.doesNotThrow(() => player.track("lol"));
    assert.deepEqual(player.trackedGames(), ["lol"], "the session keeps going from memory");
    assert.equal(player.save(player.load()), false);
});

test("private mode, where storage exists and throws on write, counts as no storage", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const { player } = boot({}, storage);
    assert.equal(player.storageAvailable(), false, "the probe write is what finds this out");
    assert.doesNotThrow(() => player.load());
});

test("a record from a later version is read but never written over", () => {
    const storage = new FakeStorage();
    const future = { version: 9, profile: { xp: 5000 }, games: { tracked: ["lol"] }, somethingNew: true };
    storage.items.set(KEY, JSON.stringify(future));
    const { player } = boot({}, storage);

    assert.deepEqual(player.trackedGames(), ["lol"], "what this version understands, it uses");
    player.track("cs2");
    player.recordContract(1, 800, 2);
    assert.deepEqual(JSON.parse(storage.getItem(KEY)!), future, "and it does not write over what it does not");
});

test("tracking is a toggle, and it is idempotent", () => {
    const { player } = boot();
    assert.equal(player.isTracked("lol"), false);
    assert.equal(player.toggleTracked("lol"), true);
    assert.equal(player.isTracked("lol"), true);
    player.track("lol");
    assert.deepEqual(player.trackedGames(), ["lol"], "tracking twice tracks once");
    assert.equal(player.toggleTracked("lol"), false);
    assert.deepEqual(player.trackedGames(), []);
    player.untrack("lol");
    assert.deepEqual(player.trackedGames(), [], "untracking what is not tracked is fine");
});

test("tracked order is the order they were tracked in", () => {
    const { player } = boot();
    player.track("warzone");
    player.track("cs2");
    player.track("lol");
    assert.deepEqual(player.trackedGames(), ["warzone", "cs2", "lol"]);
});

// === ONE SHOT ===

test("a clear is the prototype's three writes: the best stars, the points as XP, the next contract", () => {
    const { player, storage } = boot();
    player.recordContract(1, 1325, 3);
    let shot = player.oneShot();
    assert.equal(shot.stars[0], 3);
    assert.equal(shot.xp, 1325);
    assert.equal(shot.unlocked, 2);

    // Replaying a contract adds its points again, as the game did, and never lowers its stars.
    player.recordContract(1, 640, 1);
    shot = player.oneShot();
    assert.equal(shot.stars[0], 3, "a worse clear does not take stars away");
    assert.equal(shot.xp, 1325 + 640, "every clear's points are XP");
    assert.equal(shot.unlocked, 2, "replaying contract 1 unlocks nothing new");

    // Clearing an earlier contract after a later one never locks anything again.
    player.recordContract(5, 700, 1);
    player.recordContract(2, 700, 1);
    assert.equal(player.oneShot().unlocked, 6);
    assert.equal(stored(storage!).arcade.oneShot.unlocked, 6, "and it is on disk, not only in memory");
});

test("the last contract unlocks nothing past itself", () => {
    const { player } = boot({ [KEY]: { version: 2, arcade: { oneShot: { unlocked: 80 } } } });
    player.recordContract(80, 103200, 3);
    assert.equal(player.oneShot().unlocked, 80);
    assert.equal(player.oneShot().stars[79], 3);
});

test("a clear outside the eighty contracts, or with nonsense in it, changes nothing it should not", () => {
    const { player } = boot();
    assert.equal(player.recordContract(0, 500, 3), false);
    assert.equal(player.recordContract(81, 500, 3), true, "clamped to the last contract, as unlocking is");
    assert.equal(player.recordContract("x", 500, 3), false);
    const before = player.oneShot().xp;
    player.recordContract(2, -900, 7);
    assert.equal(player.oneShot().xp, before, "negative points take nothing away");
    assert.equal(player.oneShot().stars[1], 3, "stars are capped at three");
});

test("real play is never truncated: a streak clear at contract 80 and four million XP both fit", () => {
    // The previous ledger capped one award at 100,000 and all XP at 10,000,000. A clear at contract 80 on
    // an unbroken streak is worth (500 + 14 x 35 + 300) x 80 = 103,200 points, and a perfect run of all
    // eighty is about 4.2 million — so a few perfect runs would have hit the old ceiling.
    const { player } = boot({ [KEY]: { version: 2, profile: { xp: 9990000 } } });
    player.recordContract(80, 103200, 3);
    assert.equal(player.oneShot().xp, 9990000 + 103200);
});

test("the best full-run score is kept where it beats the last", () => {
    const { player } = boot();
    assert.equal(player.recordFinish(250000), true);
    assert.equal(player.recordFinish(100), false);
    assert.equal(player.oneShot().bestScore, 250000);
    assert.equal(player.recordFinish(250001), true);
    assert.equal(player.oneShot().bestScore, 250001);
});

test("ranks are the game's: one every 8,000 XP, and the ninth is the last", () => {
    const { player } = boot();
    assert.deepEqual(player.RANKS, [...ONE_SHOT_RANKS]);
    assert.equal(player.RANK_XP, ONE_SHOT_RANK_XP);
    assert.equal(player.CONTRACTS, ONE_SHOT_CONTRACTS);
    assert.equal(player.rankFor(0), "Recruit");
    assert.equal(player.rankFor(7999), "Recruit");
    assert.equal(player.rankFor(8000), "Rookie");
    assert.equal(player.rankFor(18240), "Marksman");
    assert.equal(player.rankFor(64000), "Master Sniper");
    assert.equal(player.rankFor(1e11), "Master Sniper");
});

test("the totals the card shows are counted from the stars, not stored beside them", () => {
    const { player } = boot();
    player.recordContract(1, 1200, 3);
    player.recordContract(2, 800, 2);
    player.recordContract(3, 600, 1);
    const shot = player.oneShot();
    assert.equal(shot.starsTotal, 6);
    assert.equal(shot.cleared, 3);
    shot.stars[0] = 0;
    assert.equal(player.oneShot().stars[0], 3, "oneShot() is a copy; changing it changes nothing stored");
});

// === The header chip ===

test("the chip is a compact identity: rank and XP, nothing else", () => {
    const { player } = boot({ [KEY]: { version: 2, profile: { xp: 18240 }, arcade: { oneShot: { unlocked: 34, stars: [3, 3, 2] } } } });
    assert.equal(player.chipText(), `MARKSMAN · ${(18240).toLocaleString()} XP`);
    assert.ok(!/L\d+\/80|★|contract/i.test(player.chipText()!), "the contract and the stars are not the header's");
});

test("the chip says nothing about a visitor with no XP", () => {
    assert.equal(boot().player.chipText(), null);
});

// === Version 2, and the record version 1 wrote ===

test("a version-1 record is read as it was: tracked games and XP stay, and ONE SHOT starts at contract 1", () => {
    const { player } = boot({ [KEY]: VERSION_ONE });
    assert.deepEqual(player.trackedGames(), ["lol", "gta"]);
    assert.equal(player.profile().xp, 320, "XP already earned stays");
    assert.equal(player.oneShot().unlocked, 1);
    assert.equal(player.oneShot().cleared, 0);
});

test("RESET//SCOPE's records are carried untouched through every write, for a rollback", () => {
    const storage = new FakeStorage();
    storage.items.set(KEY, JSON.stringify(VERSION_ONE));
    const { player } = boot({}, storage);
    player.recordContract(1, 900, 2);
    player.track("cs2");
    const record = stored(storage);
    assert.equal(record.version, 2);
    assert.deepEqual(record.arcade.resetScope, VERSION_ONE.arcade.resetScope);
    assert.deepEqual(record.achievements, VERSION_ONE.achievements);
    assert.deepEqual(record.profile.awarded, VERSION_ONE.profile.awarded);
    assert.equal(record.profile.xp, 320 + 900);
});

test("the previous version of this file leaves a version-2 record alone", () => {
    // What a tab left open across the release — or a rollback — runs. It must read what it understands
    // and never write, because its defaults have no arcade.oneShot and a write would delete it.
    // The file exactly as it shipped before ONE SHOT (fc787e0), kept as a fixture: CI checks out one commit.
    const previous = fs.readFileSync(path.join(ROOT, "scripts", "v2", "__tests__", "fixtures", "one-shot", "player-v1.js"), "utf8");
    const storage = new FakeStorage();
    const now = boot({}, storage).player;
    now.recordContract(1, 1325, 3);
    const written = storage.items.get(KEY);

    const window: Record<string, unknown> = { localStorage: storage };
    // eslint-disable-next-line no-new-func
    (new Function("window", "document", previous) as (w: unknown, d: unknown) => void)(window, {});
    const old = window.NextResetPlayer as { track(game: string): boolean; trackedGames(): string[]; profile(): { xp: number } };
    assert.equal(old.profile().xp, 1325, "the old page reads the XP");
    old.track("lol");
    assert.equal(storage.items.get(KEY), written, "and writes nothing over the new record");
});

test("tracking earns no XP any more, and XP it earned before stays", () => {
    const { player } = boot();
    player.track("lol");
    player.track("gta");
    assert.equal(player.profile().xp, 0, "ONE SHOT is where XP comes from");
    assert.equal(player.chipText(), null, "so tracking alone does not light the chip");

    const returning = boot({ [KEY]: { version: 1, profile: { xp: 20, awarded: ["first-track"] }, games: { tracked: ["lol"] } } }).player;
    returning.track("cs2");
    assert.equal(returning.profile().xp, 20, "the 20 XP granted for a first track is kept");
});

test("state survives a page load", () => {
    const storage = new FakeStorage();
    const first = boot({}, storage).player;
    first.track("genshin");
    first.recordContract(1, 1325, 3);
    first.recordContract(2, 910, 2);

    const second = boot({}, storage).player;
    assert.deepEqual(second.trackedGames(), ["genshin"]);
    const shot = second.oneShot();
    assert.equal(shot.xp, 1325 + 910);
    assert.equal(shot.unlocked, 3);
    assert.deepEqual(shot.stars.slice(0, 3), [3, 2, 0]);
});

test("everything lives under one key", () => {
    const storage = new FakeStorage();
    const { player } = boot({}, storage);
    player.track("lol");
    player.recordContract(1, 500, 1);
    player.recordFinish(999);
    assert.deepEqual([...storage.items.keys()], [KEY], "no second format, ever — and none of the prototype's nr* keys");
});

test("reading the state does not write on every load", () => {
    const storage = new FakeStorage();
    boot({}, storage);
    const afterFirst = storage.writes;
    boot({}, storage);
    assert.equal(storage.writes, afterFirst, "a load with nothing to migrate writes nothing");
});

test("loading a page, reloading it or coming back earns nothing", () => {
    const storage = new FakeStorage();
    for (let i = 0; i < 5; i++) boot({}, storage).player.load();
    assert.equal(boot({}, storage).player.profile().xp, 0);
});

// === Codex review of #48 ===

test("two open tabs do not erase each other's changes", () => {
    // Codex P1 on #48, reproduced: tab B was opened before tab A tracked a game. B then clears a contract.
    // B used to write its whole cached record back, and the tracked game was gone.
    const storage = new FakeStorage();
    const tabB = boot({}, storage).player;
    tabB.load();
    const tabA = boot({}, storage).player;

    tabA.track("lol");
    tabB.recordContract(1, 1100, 3);

    const later = boot({}, storage).player;
    assert.deepEqual(later.trackedGames(), ["lol"], "tab B's clear erased the game tab A tracked");
    assert.equal(later.oneShot().xp, 1100, "and the clear itself must land too");
});

test("the other direction as well: tracking in one tab keeps a contract cleared in another", () => {
    const storage = new FakeStorage();
    const home = boot({}, storage).player;
    home.load();
    const arcade = boot({}, storage).player;

    arcade.recordContract(1, 1100, 3);
    arcade.recordContract(2, 950, 2);
    home.track("genshin");

    const later = boot({}, storage).player;
    assert.equal(later.oneShot().xp, 2050, "tracking in the stale tab wiped the XP");
    assert.equal(later.oneShot().unlocked, 3, "and the contracts unlocked");
    assert.deepEqual(later.oneShot().stars.slice(0, 2), [3, 2], "and the stars");
    assert.deepEqual(later.trackedGames(), ["genshin"]);
});

test("two tabs clearing contracts both land", () => {
    const storage = new FakeStorage();
    const one = boot({}, storage).player;
    const two = boot({}, storage).player;
    one.load();
    two.load();
    one.recordContract(1, 1000, 3);
    two.recordContract(1, 500, 1);
    assert.equal(boot({}, storage).player.oneShot().xp, 1500);
    assert.equal(boot({}, storage).player.oneShot().stars[0], 3, "the other tab's worse clear did not lower the stars");
});

test("toggling decides from what is stored, not from a stale copy", () => {
    const storage = new FakeStorage();
    const stale = boot({}, storage).player;
    stale.load();
    boot({}, storage).player.track("cs2");
    // This tab still believes cs2 is untracked. Toggling must untrack it, not "track" it again.
    assert.equal(stale.toggleTracked("cs2"), false);
    assert.deepEqual(boot({}, storage).player.trackedGames(), []);
});

test("a full quota still lets a returning visitor read their record", () => {
    // Codex P2 on #48: the availability probe is a write, a full quota refuses it, and the page then
    // treated storage as absent and showed the defaults for the whole visit.
    const storage = new FakeStorage();
    storage.items.set(KEY, JSON.stringify({ version: 2, profile: { xp: 18240 }, games: { tracked: ["lol", "gta"] }, arcade: { oneShot: { unlocked: 34 } } }));
    storage.failWrites = true;
    const { player } = boot({}, storage);
    assert.deepEqual(player.trackedGames(), ["lol", "gta"]);
    assert.equal(player.profile().xp, 18240);
    assert.equal(player.oneShot().unlocked, 34);
    assert.equal(player.storageAvailable(), false, "reads work; persisting does not, and that is what this reports");
});

test("with writes refused, a change made on the page survives the rest of the page", () => {
    // The multi-tab fix re-reads storage before each change. Where a write cannot land, re-reading would
    // silently undo every change the visitor makes, so memory has to win there.
    const storage = new FakeStorage();
    storage.failWrites = true;
    const { player } = boot({}, storage);
    player.track("valorant");
    player.recordContract(1, 1000, 3);
    player.recordContract(2, 900, 2);
    assert.deepEqual(player.trackedGames(), ["valorant"]);
    assert.equal(player.oneShot().xp, 1900);
    assert.equal(player.oneShot().unlocked, 3);
});

test("what save() keeps in memory is what it wrote, not what it was given", () => {
    // Codex P2 on #48: the cache held the caller's object, so a rejected value stayed live and
    // save({}) left a record with no profile until the next reload.
    const { player } = boot();
    player.save({});
    assert.doesNotThrow(() => player.profile());
    assert.equal(player.profile().xp, 0);
    assert.doesNotThrow(() => player.oneShot());

    player.save({ version: 2, profile: { xp: -50 }, games: { tracked: ["nope", "lol"] }, arcade: { oneShot: { unlocked: 500 } } });
    assert.equal(player.profile().xp, 0, "a negative XP was rejected on disk and kept in memory");
    assert.equal(player.oneShot().unlocked, 80, "an impossible contract was rejected on disk and kept in memory");
    assert.deepEqual(player.trackedGames(), ["lol"], "an unknown game was rejected on disk and kept in memory");
});

// === Codex review of #58 ===

test("a record from a later version keeps this session's changes, and is never written over", () => {
    // Codex P2 on #58: fresh() re-read the future record before every change while save() refused to
    // write it, so track("cs2") then track("gta") lost cs2, and a second change lost the first.
    const future = JSON.stringify({ version: 99, profile: { xp: 500 }, games: { tracked: ["lol"] }, somethingNew: true });
    const storage = new FakeStorage();
    storage.items.set(KEY, future);
    const { player } = boot({}, storage);
    player.track("cs2");
    player.track("gta");
    assert.deepEqual(player.trackedGames(), ["lol", "cs2", "gta"], "a change was lost to a re-read");
    player.recordContract(1, 700, 2);
    player.recordContract(2, 800, 2);
    assert.equal(player.oneShot().xp, 500 + 700 + 800, "a clear vanished when the next one landed");
    assert.equal(player.oneShot().unlocked, 3);
    assert.equal(storage.getItem(KEY), future, "the later version's record must be left exactly as it was");
});

test("refresh() sees another tab's change where storage is authoritative", () => {
    const storage = new FakeStorage();
    const here = boot({}, storage).player;
    here.load();
    boot({}, storage).player.track("pubg");
    here.refresh();
    assert.deepEqual(here.trackedGames(), ["pubg"]);
});

test("refresh() keeps changes that only this page holds", () => {
    // Codex P2 on #58: a back-forward restore called forget() unconditionally. With writes failing,
    // memory held the only copy of a newly tracked game and a clear, and Back threw both away.
    const storage = new FakeStorage();
    storage.failWrites = true;
    const { player } = boot({}, storage);
    player.track("valorant");
    player.recordContract(1, 1000, 3);
    player.refresh();
    assert.deepEqual(player.trackedGames(), ["valorant"]);
    assert.equal(player.oneShot().xp, 1000);
});

// === Codex review of 1fb2502 ===

test("a read that fails mid-visit is not taken for a clear: the record survives, in memory and on disk", () => {
    // Codex P2: readJson returned null both for an absent key and for a getItem() that threw, so a read
    // failure looked like another tab clearing storage. The page threw away its good copy, rebuilt from
    // the defaults, and — if writes still worked — wrote those defaults over the visitor's record.
    const record = { version: 2, profile: { xp: 18240 }, games: { tracked: ["lol"] }, arcade: { oneShot: { unlocked: 34, stars: [3, 3] } } };
    const storage = new FakeStorage();
    storage.items.set(KEY, JSON.stringify(record));
    const { player } = boot({}, storage);
    player.load();

    storage.failReads = true;
    player.track("gta");
    assert.deepEqual(player.trackedGames(), ["lol", "gta"], "the tracked game from before the failure was lost");
    assert.equal(player.oneShot().unlocked, 34, "ONE SHOT's progress was reset to the defaults");
    assert.ok(player.profile().xp >= 18240, "the XP was reset to the defaults");

    storage.failReads = false;
    const onDisk = stored(storage);
    assert.deepEqual(onDisk.games.tracked, ["lol"], "defaults were written over the record");
    assert.equal(onDisk.arcade.oneShot.unlocked, 34);
});

test("a genuinely cleared record is still respected as the latest change", () => {
    const storage = new FakeStorage();
    const { player } = boot({}, storage);
    player.track("cs2");
    storage.items.delete(KEY);                  // cleared, e.g. in another tab
    player.track("pubg");
    assert.deepEqual(player.trackedGames(), ["pubg"], "a real clear should not be undone from memory");
});

test("a record that is there but will not parse is repaired, as before", () => {
    const storage = new FakeStorage();
    storage.items.set(KEY, "{not json");
    const { player } = boot({}, storage);
    assert.deepEqual(player.trackedGames(), []);
    assert.doesNotThrow(() => JSON.parse(storage.items.get(KEY)!), "the unreadable record was left in place");
});

// === Codex review of 465d6a3 ===

test("a resync whose read fails keeps everything the page holds", () => {
    // Codex P2: refresh() dropped the cache before reading, so a getItem() that threw during a
    // back-forward or cross-tab resync left the page rebuilding from the defaults — the visitor's tracked
    // games, XP and progress gone for the rest of the visit.
    const storage = new FakeStorage();
    storage.items.set(KEY, JSON.stringify({ ...VERSION_ONE, version: 2, arcade: { ...VERSION_ONE.arcade, oneShot: { unlocked: 12 } } }));
    const { player } = boot({}, storage);
    player.load();
    storage.failReads = true;
    player.refresh();
    assert.deepEqual(player.trackedGames(), ["lol", "gta"]);
    assert.equal(player.profile().xp, 320);
    assert.equal(player.oneShot().unlocked, 12);
});

test("a resync that reads successfully still picks up another tab's change", () => {
    const storage = new FakeStorage();
    const here = boot({}, storage).player;
    here.load();
    boot({}, storage).player.track("warzone");
    here.refresh();
    assert.deepEqual(here.trackedGames(), ["warzone"]);
});

// === Codex review of 1fb2502 (missed at the time) and 4731a65 ===

test("with no storage at all, a resync keeps what the page holds", () => {
    // Codex P2 on 1fb2502: storage() returned null but writable stayed true, so the predicate said
    // storage was authoritative and a back-forward resync could clear the only copy. reread() already
    // keeps the copy when there is no store (4731a65); this holds both the predicate and the behaviour.
    const { player } = boot({}, null);
    player.track("lol");
    player.recordContract(1, 1000, 3);
    player.refresh();
    assert.deepEqual(player.trackedGames(), ["lol"]);
    assert.equal(player.oneShot().xp, 1000);
});

test("player.js resyncs on a back-forward restore by itself, so pages without app.js stay current", () => {
    // Codex P2 on 4731a65: only app.js listened for pageshow, and /play/, About, Privacy and the 404 do
    // not load it — their header chip stayed stale after Back.
    const storage = new FakeStorage();
    const listeners: Record<string, (event: unknown) => void> = {};
    const window: Record<string, unknown> = {
        localStorage: storage,
        addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; }
    };
    // eslint-disable-next-line no-new-func
    (new Function("window", "document", SOURCE) as (w: unknown, d: unknown) => void)(window, {});
    const player = window.NextResetPlayer as Player;
    assert.ok(listeners.pageshow, "player.js registers no pageshow handler");

    const elsewhere = boot({}, storage).player;          // the game, in the page the visitor went to
    elsewhere.track("valorant");
    elsewhere.recordContract(1, 1200, 3);
    assert.deepEqual(player.trackedGames(), [], "before the restore this page still shows its old copy");
    listeners.pageshow({ persisted: true });            // pressing Back
    assert.deepEqual(player.trackedGames(), ["valorant"]);
    assert.equal(player.oneShot().xp, 1200);

    listeners.pageshow({ persisted: false });           // an ordinary load is not a restore
});
