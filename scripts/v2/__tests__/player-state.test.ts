/**
 * V4, PR 3: one versioned record, and nothing it can do breaks the site.
 *
 * The prototype kept two unrelated keys and they had already drifted: the homepage read a rank from
 * `nrScopeV3` that the game never wrote, so BEST RANK was permanently "C". This suite exists so the
 * single record cannot repeat that, and so the three rules hold under the conditions a real browser
 * actually produces — private mode, a full quota, storage switched off, and a record written by a
 * version of the site that does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { gamePages } from "../../update-game-pages";

const ROOT = path.join(__dirname, "..", "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "public", "assets", "player.js"), "utf8");

/** How a browser's localStorage behaves, including the ways it refuses. */
class FakeStorage {
    items = new Map<string, string>();
    failWrites = false;
    writes = 0;

    getItem(key: string): string | null {
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

interface Player {
    KEY: string;
    VERSION: number;
    GAME_IDS: string[];
    LEVEL_THRESHOLDS: number[];
    RANKS: string[];
    LEGACY_KEYS: { tracked: string; arcade: string };
    defaults(): Record<string, unknown>;
    load(): Record<string, unknown>;
    save(state: unknown): boolean;
    forget(): void;
    toGameId(value: unknown): string | null;
    trackedGames(): string[];
    isTracked(game: string): boolean;
    track(game: string): boolean;
    untrack(game: string): boolean;
    toggleTracked(game: string): boolean;
    arcadeRecords(): { highScore: number; highestMission: number; bestCombo: number; bestRank: string | null; gamesPlayed: number };
    recordRun(run: unknown): { newHighScore: boolean; newMission: boolean; newCombo: boolean; newRank: boolean };
    profile(): { xp: number; level: number; xpToNext: number | null };
    addXp(amount: unknown, reason?: string): { xp: number; level: number; xpToNext: number | null };
    levelFor(xp: number): number;
    xpToNextLevel(xp: number): number | null;
    hasAchievement(id: string): boolean;
    grantAchievement(id: string): boolean;
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

test("the twelve ids are the twelve games the site publishes", () => {
    // A game added to the site but not here would be untrackable, and nothing else would say so.
    const { player } = boot();
    assert.deepEqual(player.GAME_IDS.slice().sort(), gamePages.map(page => page.game).sort());
    assert.equal(player.GAME_IDS.length, 12);
});

test("a first visit starts at the defaults and writes them once", () => {
    const { player, storage } = boot();
    const state = player.load() as { version: number; profile: { xp: number; level: number }; games: { tracked: string[] } };
    assert.equal(state.version, 1);
    assert.deepEqual(state.games.tracked, []);
    assert.equal(state.profile.xp, 0);
    assert.equal(state.profile.level, 1);
    assert.deepEqual(player.arcadeRecords(), { highScore: 0, highestMission: 0, bestCombo: 0, bestRank: null, gamesPlayed: 0 });
    assert.ok(storage!.items.has(KEY));
});

test("the prototype's tracked names become ids, and the old key is left alone", () => {
    const { player, storage } = boot({ nrTracked: ["Genshin", "LoL", "GTA Online", "Fortnite"] });
    assert.deepEqual(player.trackedGames(), ["genshin", "lol", "gta", "fortnite"]);
    assert.equal(storage!.getItem("nrTracked"), JSON.stringify(["Genshin", "LoL", "GTA Online", "Fortnite"]),
        "the legacy key is read, never deleted: another tab may still be using it");
});

test("the prototype's arcade record is taken, including the rank it never wrote", () => {
    const { player } = boot({ nrScopeV3: { best: 48250, mission: 5 } });
    const records = player.arcadeRecords();
    assert.equal(records.highScore, 48250);
    assert.equal(records.highestMission, 5);
    assert.equal(records.bestRank, null, "a rank is earned by a run; none is invented");
    assert.equal(records.gamesPlayed, 0, "and the old key does not say how many runs there were");
});

test("both legacy keys migrate together", () => {
    const { player } = boot({ nrTracked: ["CS2"], nrScopeV3: { best: 100, mission: 2, rank: "A" } });
    assert.deepEqual(player.trackedGames(), ["cs2"]);
    assert.equal(player.arcadeRecords().highScore, 100);
    assert.equal(player.arcadeRecords().bestRank, "A");
});

test("migration only ever adds, so it is safe to run again", () => {
    const storage = new FakeStorage();
    storage.items.set("nrTracked", JSON.stringify(["LoL"]));
    storage.items.set("nrScopeV3", JSON.stringify({ best: 500, mission: 3 }));

    const first = boot({}, storage).player;
    first.track("cs2");
    first.recordRun({ score: 9000, mission: 4, combo: 7, rank: "B" });

    // A second page load re-reads the legacy keys, which are still there.
    const second = boot({}, storage).player;
    assert.deepEqual(second.trackedGames().sort(), ["cs2", "lol"], "nothing tracked in the new key was lost");
    const records = second.arcadeRecords();
    assert.equal(records.highScore, 9000, "the better score stands");
    assert.equal(records.highestMission, 4);
    assert.equal(records.bestRank, "B");
    assert.equal(records.gamesPlayed, 1, "and a re-read is not a run");
});

test("a legacy record that beats the new one still wins", () => {
    const storage = new FakeStorage();
    storage.items.set(KEY, JSON.stringify({ version: 1, arcade: { resetScope: { highScore: 10 } } }));
    storage.items.set("nrScopeV3", JSON.stringify({ best: 999 }));
    const { player } = boot({}, storage);
    assert.equal(player.arcadeRecords().highScore, 999);
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
    }
});

test("values of the wrong type are clamped rather than trusted", () => {
    const { player } = boot({
        [KEY]: {
            version: 1,
            profile: { xp: -5000, level: 99 },
            games: { tracked: ["lol", "lol", "lol"] },
            arcade: { resetScope: { highScore: "abc", highestMission: 1e9, bestCombo: -3, bestRank: "Z", gamesPlayed: 2.7 } },
            achievements: ["a", "a", 5, null, "b"]
        }
    });
    assert.equal(player.profile().xp, 0, "negative XP is no XP");
    assert.equal(player.profile().level, 1, "the level is derived from XP, never read from storage");
    assert.deepEqual(player.trackedGames(), ["lol"], "a duplicate is stored once");
    const records = player.arcadeRecords();
    assert.equal(records.highScore, 0);
    assert.equal(records.highestMission, 99, "clamped to the ceiling");
    assert.equal(records.bestCombo, 0);
    assert.equal(records.bestRank, null, "a rank the game does not have is not a rank");
    assert.equal(records.gamesPlayed, 2, "a fraction is floored");
    assert.ok(player.hasAchievement("a") && player.hasAchievement("b"));
});

test("storage switched off leaves a working site", () => {
    const { player } = boot({}, null);
    assert.equal(player.storageAvailable(), false);
    assert.doesNotThrow(() => player.load());
    assert.equal(player.track("lol"), true, "the call still reports what it did");
    assert.deepEqual(player.trackedGames(), ["lol"], "and the session remembers it in memory");
    assert.equal(player.save(player.load()), false, "it just never reaches storage");
    assert.doesNotThrow(() => player.recordRun({ score: 1 }));
    assert.doesNotThrow(() => player.addXp(50, "test"));
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

test("a run keeps only what it beat, and always counts", () => {
    const { player } = boot();
    let broke = player.recordRun({ score: 1000, mission: 2, combo: 5, rank: "C" });
    assert.deepEqual(broke, { newHighScore: true, newMission: true, newCombo: true, newRank: true });

    broke = player.recordRun({ score: 500, mission: 1, combo: 2, rank: "D" });
    assert.deepEqual(broke, { newHighScore: false, newMission: false, newCombo: false, newRank: false });
    assert.deepEqual(player.arcadeRecords(), { highScore: 1000, highestMission: 2, bestCombo: 5, bestRank: "C", gamesPlayed: 2 });

    broke = player.recordRun({ score: 1001, mission: 2, combo: 5, rank: "S" });
    assert.equal(broke.newHighScore, true);
    assert.equal(broke.newRank, true);
    assert.equal(broke.newMission, false);
    assert.equal(player.arcadeRecords().gamesPlayed, 3);
});

test("a run with nothing in it still counts and breaks nothing", () => {
    const { player } = boot();
    const broke = player.recordRun(undefined);
    assert.deepEqual(broke, { newHighScore: false, newMission: false, newCombo: false, newRank: false });
    assert.equal(player.arcadeRecords().gamesPlayed, 1);
    assert.equal(player.arcadeRecords().highScore, 0);
});

test("ranks compare by rank, not alphabetically", () => {
    const { player } = boot();
    assert.deepEqual(player.RANKS, ["D", "C", "B", "A", "S"]);
    player.recordRun({ rank: "A" });
    assert.equal(player.arcadeRecords().bestRank, "A");
    player.recordRun({ rank: "B" });
    assert.equal(player.arcadeRecords().bestRank, "A", "B does not beat A even though it sorts earlier");
    player.recordRun({ rank: "S" });
    assert.equal(player.arcadeRecords().bestRank, "S");
});

test("XP needs a reason and a positive amount", () => {
    const { player } = boot();
    assert.equal(player.addXp(50, "completed-run").xp, 50);
    assert.equal(player.addXp(50, "").xp, 50, "no reason, no XP");
    assert.equal(player.addXp(0, "nothing").xp, 50);
    assert.equal(player.addXp(-100, "cheating").xp, 50, "XP is never taken away by a negative award");
    assert.equal(player.addXp("lots" as unknown as number, "nonsense").xp, 50);
});

test("levels come from the curve, and the curve only goes up", () => {
    const { player } = boot();
    assert.equal(player.levelFor(0), 1);
    assert.equal(player.levelFor(99), 1);
    assert.equal(player.levelFor(100), 2);
    assert.equal(player.levelFor(299), 2);
    assert.equal(player.levelFor(300), 3);
    assert.equal(player.levelFor(1e9), player.LEVEL_THRESHOLDS.length);
    for (let i = 1; i < player.LEVEL_THRESHOLDS.length; i++) {
        assert.ok(player.LEVEL_THRESHOLDS[i] > player.LEVEL_THRESHOLDS[i - 1], "the curve is strictly increasing");
    }
    assert.equal(player.xpToNextLevel(0), 100);
    assert.equal(player.xpToNextLevel(250), 50);
    assert.equal(player.xpToNextLevel(1e9), null, "at the top there is no next");
});

test("an achievement is granted once", () => {
    const { player } = boot();
    assert.equal(player.grantAchievement("first-run"), true);
    assert.equal(player.grantAchievement("first-run"), false);
    assert.equal(player.hasAchievement("first-run"), true);
    assert.equal(player.grantAchievement(""), false);
    assert.equal(player.hasAchievement("never"), false);
});

test("state survives a page load", () => {
    const storage = new FakeStorage();
    const first = boot({}, storage).player;
    first.track("genshin");
    first.recordRun({ score: 4242, mission: 3, combo: 9, rank: "B" });
    first.addXp(150, "completed-run");
    first.grantAchievement("bullseye");

    const second = boot({}, storage).player;
    assert.deepEqual(second.trackedGames(), ["genshin"]);
    assert.deepEqual(second.arcadeRecords(), { highScore: 4242, highestMission: 3, bestCombo: 9, bestRank: "B", gamesPlayed: 1 });
    // 150 from the run, and 20 for tracking a first game — the ledger's one award that is not a run's.
    assert.equal(second.profile().xp, 150 + 20);
    assert.equal(second.profile().level, 2);
    assert.equal(second.hasAchievement("bullseye"), true);
});

test("everything lives under one key", () => {
    const storage = new FakeStorage();
    const { player } = boot({}, storage);
    player.track("lol");
    player.recordRun({ score: 10 });
    player.addXp(10, "x");
    player.grantAchievement("y");
    assert.deepEqual([...storage.items.keys()], [KEY], "no second format, ever");
});

test("reading the state does not write on every load", () => {
    const storage = new FakeStorage();
    boot({}, storage);
    const afterFirst = storage.writes;
    boot({}, storage);
    assert.equal(storage.writes, afterFirst, "a load with nothing to migrate writes nothing");
});

// === Codex review of #48, and #53's first-track award ===

test("two open tabs do not erase each other's changes", () => {
    // Codex P1 on #48, reproduced exactly: tab B was opened before tab A tracked a game. B then records
    // a run. B used to write its whole cached record back, and the tracked game was gone.
    const storage = new FakeStorage();
    const tabB = boot({}, storage).player;
    tabB.load();
    const tabA = boot({}, storage).player;

    tabA.track("lol");
    tabB.recordRun({ score: 9100, mission: 2, combo: 6, rank: "B" });

    const later = boot({}, storage).player;
    assert.deepEqual(later.trackedGames(), ["lol"], "tab B's run erased the game tab A tracked");
    assert.equal(later.arcadeRecords().highScore, 9100, "and the run itself must land too");
});

test("the other direction as well: tracking in one tab keeps a run finished in another", () => {
    const storage = new FakeStorage();
    const home = boot({}, storage).player;
    home.load();
    const arcade = boot({}, storage).player;

    arcade.recordRun({ score: 14303, mission: 2, combo: 8, rank: "B" });
    arcade.addXp(175, "completed-run");
    arcade.grantAchievement("first-run");
    home.track("genshin");

    const later = boot({}, storage).player;
    assert.equal(later.arcadeRecords().highScore, 14303, "tracking in the stale tab wiped the high score");
    assert.equal(later.profile().xp, 175 + 20, "and the XP");
    assert.equal(later.hasAchievement("first-run"), true, "and the achievement");
    assert.deepEqual(later.trackedGames(), ["genshin"]);
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
    storage.items.set(KEY, JSON.stringify({
        version: 1, profile: { xp: 320, level: 3 }, games: { tracked: ["lol", "gta"] },
        arcade: { resetScope: { highScore: 5000, highestMission: 2, bestCombo: 4, bestRank: "C", gamesPlayed: 2 } },
        achievements: ["first-run"]
    }));
    storage.failWrites = true;
    const { player } = boot({}, storage);
    assert.deepEqual(player.trackedGames(), ["lol", "gta"]);
    assert.equal(player.profile().xp, 320);
    assert.equal(player.arcadeRecords().highScore, 5000);
    assert.equal(player.storageAvailable(), false, "reads work; persisting does not, and that is what this reports");
});

test("with writes refused, a change made on the page survives the rest of the page", () => {
    // The multi-tab fix re-reads storage before each change. Where a write cannot land, re-reading would
    // silently undo every change the visitor makes, so memory has to win there.
    const storage = new FakeStorage();
    storage.failWrites = true;
    const { player } = boot({}, storage);
    player.track("valorant");
    player.track("pubg");
    assert.deepEqual(player.trackedGames(), ["valorant", "pubg"]);
});

test("what save() keeps in memory is what it wrote, not what it was given", () => {
    // Codex P2 on #48: the cache held the caller's object, so a rejected value stayed live and
    // save({}) left a record with no profile until the next reload.
    const { player } = boot();
    player.save({});
    assert.doesNotThrow(() => player.profile());
    assert.equal(player.profile().xp, 0);

    player.save({ version: 1, profile: { xp: -50, level: 99 }, games: { tracked: ["nope", "lol"] } });
    assert.equal(player.profile().xp, 0, "a negative XP was rejected on disk and kept in memory");
    assert.equal(player.profile().level, 1, "the level is derived, never trusted");
    assert.deepEqual(player.trackedGames(), ["lol"], "an unknown game was rejected on disk and kept in memory");
});

test("tracking a first game earns the XP the ledger advertises, once", () => {
    // Codex P2 on #53: "Tracking your first game, +20" was printed on /play/ and granted by nothing.
    const { player } = boot();
    player.track("lol");
    assert.equal(player.profile().xp, 20);
    player.untrack("lol");
    player.track("lol");
    player.track("gta");
    assert.equal(player.profile().xp, 20, "untracking and tracking again must not farm it");
});

test("the first-track award is the amount the printed ledger says", () => {
    const core = fs.readFileSync(path.join(ROOT, "public", "assets", "scope-core.js"), "utf8");
    const entry = /\{\s*id:\s*'first-track',\s*xp:\s*(\d+)/.exec(core);
    assert.ok(entry, "scope-core.js no longer lists first-track");
    const { player } = boot();
    const award = (player as unknown as { FIRST_TRACK: { id: string; xp: number } }).FIRST_TRACK;
    assert.equal(award.id, "first-track");
    assert.equal(award.xp, Number(entry![1]), "player.js grants a different amount than /play/ prints");
});

test("loading a page, reloading it or coming back earns nothing", () => {
    const storage = new FakeStorage();
    for (let i = 0; i < 5; i++) boot({}, storage).player.load();
    assert.equal(boot({}, storage).player.profile().xp, 0);
});
