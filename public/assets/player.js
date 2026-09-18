/**
 * NextReset — local player state.
 *
 * One versioned record under one key, `nextreset.player.v1`, holding everything the site remembers
 * about a visitor: which games they track, their arcade records, XP and achievements. There is no
 * account and no server; this is deliberately all of it.
 *
 * Why one record. The V4 prototype kept two unrelated keys, `nrTracked` and `nrScopeV3`, and they had
 * already drifted apart: the homepage read `a.rank` from the arcade record and the game never wrote it,
 * so BEST RANK was permanently "C". A second format would have produced a second version of that bug.
 *
 * Three rules this file exists to keep:
 *
 *   1. **Storage failure never breaks the site.** Safari in private mode throws on write, a visitor may
 *      have storage disabled, and a quota can be full. Every access is guarded and every failure ends
 *      with the site working and the state at its defaults.
 *   2. **Stored data is input, not a contract.** It was written by an older version of this file, or by
 *      a person with a console open. Everything read is validated and clamped; anything unrecognised is
 *      dropped rather than trusted.
 *   3. **Nothing here is ever a published fact.** Tracking a game changes the order things appear in and
 *      nothing else. A verified value, its state, its source and its freshness come from the build, and
 *      no code in this file may touch them.
 *
 * Loaded before app.js. Exposed as a global rather than a module because the rest of the site is plain
 * scripts, and one small global is a smaller thing to justify than a build step.
 */
(function (global) {
    'use strict';

    var KEY = 'nextreset.player.v1';
    var VERSION = 1;

    /**
     * Keys written by the V4 prototype, read once and then left alone.
     *
     * Never deleted. A visitor who has the prototype open in another tab would otherwise lose their
     * records to whichever tab wrote last, and a rollback of this release would land on empty storage.
     * Migration is therefore additive and repeatable: reading these twice produces the same result.
     */
    var LEGACY_TRACKED = 'nrTracked';
    var LEGACY_ARCADE = 'nrScopeV3';

    /** The element the shared header gives this file to fill. Kept in step by chrome.test.ts. */
    var CHIP_ID = 'chrome-player';

    /**
     * What tracking a first game earns: the one entry in the XP ledger that is not earned by a run.
     *
     * The ledger lives in scope-core.js, which does not load on the pages where tracking happens, so the
     * amount is repeated here and player-state.test.ts holds the two copies together. It was printed on
     * /play/ for a release before anything granted it.
     */
    var FIRST_TRACK = { id: 'first-track', xp: 20 };

    /**
     * The twelve games the site tracks.
     *
     * This list is checked against the page registry by player-state.test.ts, so a game added to the
     * site without being added here fails the build rather than being silently untrackable.
     */
    var GAME_IDS = [
        'cs2', 'ea-sports-fc', 'fortnite', 'genshin', 'gta', 'lol',
        'minecraft', 'pubg', 'red-dead-redemption-2', 'roblox', 'valorant', 'warzone'
    ];

    /**
     * What the prototype called each game, so a visitor's tracked list survives the move to ids.
     *
     * The prototype stored display names ("GTA Online"), which cannot be used as identifiers: they are
     * translated, they change, and two of them differ only in punctuation. Matching is case-insensitive
     * and ignores spaces and dots, so "CS2", "cs2" and "C.S.2" all land in the same place.
     */
    var LEGACY_NAMES = {
        'genshin': 'genshin',
        'genshinimpact': 'genshin',
        'lol': 'lol',
        'leagueoflegends': 'lol',
        'gtaonline': 'gta',
        'gta': 'gta',
        'fortnite': 'fortnite',
        'valorant': 'valorant',
        'cs2': 'cs2',
        'counterstrike2': 'cs2',
        'minecraft': 'minecraft',
        'roblox': 'roblox',
        'pubg': 'pubg',
        'warzone': 'warzone',
        'reddeadredemption2': 'red-dead-redemption-2',
        'easportsfc': 'ea-sports-fc'
    };

    /**
     * XP needed to reach each level, lowest first.
     *
     * Explicit rather than a formula, so the curve can be read. Level 1 is where everyone starts; the
     * gaps widen so that early progress is quick and later progress means something. What earns XP is
     * decided elsewhere — this file only knows how much of it makes a level.
     */
    var LEVEL_THRESHOLDS = [0, 100, 300, 700, 1400, 2600, 4500, 7200, 11000, 16000];

    /** Arcade ranks, worst to best, so "is this a new best" is a comparison rather than a guess. */
    var RANKS = ['D', 'C', 'B', 'A', 'S'];

    function defaults() {
        return {
            version: VERSION,
            profile: { xp: 0, level: 1, awarded: [] },
            games: { tracked: [] },
            arcade: {
                resetScope: {
                    highScore: 0,
                    highestMission: 0,
                    bestCombo: 0,
                    bestRank: null,
                    gamesPlayed: 0
                }
            },
            achievements: []
        };
    }

    var storageProbe;
    // False once a write has failed. Reads carry on; writes stop being attempted, and changes are kept in
    // memory for the rest of the page, because re-reading storage would silently undo them.
    var writable = true;

    /**
     * localStorage, or null where it cannot be reached. Never throws.
     *
     * The probe is a real write, because Safari in private mode has the object and refuses the write —
     * presence is not availability. It runs once per page: probing on every call meant a setItem and a
     * removeItem for each read of a record that is read several times a page.
     *
     * Availability can still lapse afterwards (a quota fills), which is why every write is also guarded.
     */
    function storage() {
        if (storageProbe !== undefined) return storageProbe;
        storageProbe = null;
        try {
            var s = global.localStorage;
            if (s) {
                // Reading is what every page needs, and this throws where storage is blocked outright.
                s.getItem(KEY);
                storageProbe = s;
                // A failed write is a different thing: a full quota, or Safari's old private mode. The
                // record already there is still readable, and treating a refused probe as "no storage"
                // would show a returning visitor the defaults for the whole visit.
                try {
                    var probe = '__nr_probe__';
                    s.setItem(probe, '1');
                    s.removeItem(probe);
                } catch (e) {
                    writable = false;
                }
            }
        } catch (e) {
            storageProbe = null;
        }
        return storageProbe;
    }

    function readJson(store, key) {
        if (!store) return null;
        try {
            var raw = store.getItem(key);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    /** A whole number in range, or the fallback. Stored numbers are input like any other. */
    function whole(value, fallback, max) {
        var n = typeof value === 'number' ? value : parseInt(value, 10);
        if (!isFinite(n) || n < 0) return fallback;
        n = Math.floor(n);
        return max !== undefined && n > max ? max : n;
    }

    function normaliseName(name) {
        return String(name === undefined || name === null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    /** A stored game reference to one of the twelve ids, or null if it names nothing the site tracks. */
    function toGameId(value) {
        var raw = String(value === undefined || value === null ? '' : value).trim();
        if (GAME_IDS.indexOf(raw) !== -1) return raw;
        var mapped = LEGACY_NAMES[normaliseName(raw)];
        return mapped || null;
    }

    /** The level a given amount of XP has reached. */
    function levelFor(xp) {
        var level = 1;
        for (var i = 0; i < LEVEL_THRESHOLDS.length; i++) {
            if (xp >= LEVEL_THRESHOLDS[i]) level = i + 1;
        }
        return level;
    }

    /** XP still to go before the next level, or null at the top of the curve. */
    function xpToNextLevel(xp) {
        for (var i = 0; i < LEVEL_THRESHOLDS.length; i++) {
            if (xp < LEVEL_THRESHOLDS[i]) return LEVEL_THRESHOLDS[i] - xp;
        }
        return null;
    }

    /** Whatever was stored, made into a state this code is willing to use. */
    function sanitise(stored) {
        var state = defaults();
        if (!stored || typeof stored !== 'object') return state;

        var profile = stored.profile && typeof stored.profile === 'object' ? stored.profile : {};
        state.profile.xp = whole(profile.xp, 0, 10000000);
        // The level is derived, never trusted: a stored level that disagrees with the XP is the kind of
        // thing a console edit produces, and the XP is the fact.
        state.profile.level = levelFor(state.profile.xp);
        state.profile.awarded = (Array.isArray(profile.awarded) ? profile.awarded : [])
            .filter(function (id) { return typeof id === 'string' && id.length > 0 && id.length <= 64; })
            .filter(function (id, i, all) { return all.indexOf(id) === i; })
            .slice(0, 50);

        var games = stored.games && typeof stored.games === 'object' ? stored.games : {};
        state.games.tracked = uniqueIds(Array.isArray(games.tracked) ? games.tracked : []);

        var arcade = stored.arcade && typeof stored.arcade === 'object' ? stored.arcade : {};
        var scope = arcade.resetScope && typeof arcade.resetScope === 'object' ? arcade.resetScope : {};
        state.arcade.resetScope = {
            highScore: whole(scope.highScore, 0, 100000000),
            highestMission: whole(scope.highestMission, 0, 99),
            bestCombo: whole(scope.bestCombo, 0, 9999),
            bestRank: RANKS.indexOf(scope.bestRank) !== -1 ? scope.bestRank : null,
            gamesPlayed: whole(scope.gamesPlayed, 0, 1000000)
        };

        state.achievements = (Array.isArray(stored.achievements) ? stored.achievements : [])
            .filter(function (id) { return typeof id === 'string' && id.length > 0 && id.length <= 64; })
            .filter(function (id, i, all) { return all.indexOf(id) === i; })
            .slice(0, 200);

        return state;
    }

    function uniqueIds(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var id = toGameId(list[i]);
            if (id && out.indexOf(id) === -1) out.push(id);
        }
        return out;
    }

    /**
     * Folds the prototype's two keys into a state that does not have them yet.
     *
     * Only ever adds. A tracked game from the old key joins the list; an arcade record is taken only
     * where it beats what is already stored. So running this twice, or running it after the visitor has
     * played once under the new key, cannot lose anything.
     */
    function migrate(state, store) {
        var changed = false;

        var legacyTracked = readJson(store, LEGACY_TRACKED);
        // The prototype stored a bare array under this key.
        var names = Array.isArray(legacyTracked) ? legacyTracked : null;
        if (!names && store) {
            try {
                var raw = store.getItem(LEGACY_TRACKED);
                if (raw) {
                    var parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) names = parsed;
                }
            } catch (e) { /* not ours to fix */ }
        }
        if (names) {
            for (var i = 0; i < names.length; i++) {
                var id = toGameId(names[i]);
                if (id && state.games.tracked.indexOf(id) === -1) {
                    state.games.tracked.push(id);
                    changed = true;
                }
            }
        }

        var legacyArcade = readJson(store, LEGACY_ARCADE);
        if (legacyArcade) {
            var scope = state.arcade.resetScope;
            var best = whole(legacyArcade.best, 0, 100000000);
            if (best > scope.highScore) { scope.highScore = best; changed = true; }
            var mission = whole(legacyArcade.mission, 0, 99);
            if (mission > scope.highestMission) { scope.highestMission = mission; changed = true; }
            // The prototype read a rank it never wrote. If one is there, it is taken; if not, nothing is
            // invented — a rank is earned by a run, and this state has never seen one.
            if (RANKS.indexOf(legacyArcade.rank) > RANKS.indexOf(scope.bestRank)) {
                scope.bestRank = legacyArcade.rank;
                changed = true;
            }
        }

        return changed;
    }

    var cache = null;

    /** The current state. Reads storage once per page, then serves the same object. */
    function load() {
        if (cache) return cache;
        var store = storage();
        var stored = readJson(store, KEY);
        var state = sanitise(stored);

        // A record written by a later version of the site is left exactly where it is. Rolling a release
        // back must not cost a visitor their progress, so this version reads what it understands and
        // never writes over what it does not.
        var future = stored && whole(stored.version, VERSION) > VERSION;
        state.fromFuture = !!future;

        if (!future) {
            var migrated = migrate(state, store);
            if (migrated || !stored) save(state);
        }

        cache = state;
        return state;
    }

    /**
     * The record as it stands in storage now, for a change about to be written.
     *
     * Another tab may have written since this page loaded. Starting a change from this page's copy and
     * writing the whole record back would put that tab's changes out of existence — a game tracked
     * there, a run finished there. So every change starts from what is stored, and falls back to memory
     * only where storage could not take the write anyway.
     */
    function fresh() {
        var store = storage();
        if (!store || !writable) return load();
        var stored = readJson(store, KEY);
        if (!stored) {
            // Cleared elsewhere since this page loaded. The clearing is the latest change; respect it.
            cache = null;
            return load();
        }
        var state = sanitise(stored);
        state.fromFuture = whole(stored.version, VERSION) > VERSION;
        cache = state;
        return state;
    }

    /**
     * Writes the state. Returns whether it reached storage.
     *
     * Memory holds exactly what storage would, whether or not the write lands: the sanitised copy, never
     * the object the caller passed. Caching the caller's object meant a rejected value was rejected on
     * disk and kept in memory, and `save({})` left a record with no profile for the rest of the page.
     */
    function save(state) {
        if (state && state.fromFuture) return false;
        var copy = sanitise(state);
        var text = JSON.stringify(copy);
        copy.fromFuture = false;
        cache = copy;
        var store = storage();
        if (!store || !writable) return false;
        try {
            store.setItem(KEY, text);
            return true;
        } catch (e) {
            // A full quota, or storage revoked mid-session. The site keeps working from memory.
            writable = false;
            return false;
        }
    }

    function trackedGames() {
        return load().games.tracked.slice();
    }

    function isTracked(game) {
        var id = toGameId(game);
        return !!id && load().games.tracked.indexOf(id) !== -1;
    }

    /** Starts tracking a game. Unknown ids are ignored rather than stored. */
    function track(game) {
        var id = toGameId(game);
        if (!id) return false;
        var state = fresh();
        if (state.games.tracked.indexOf(id) !== -1) return true;
        state.games.tracked.push(id);
        // The one award tracking earns, once per visitor however many times they untrack and track
        // again — so it cannot be farmed, and it is never granted for loading a page.
        if (state.profile.awarded.indexOf(FIRST_TRACK.id) === -1) {
            state.profile.awarded.push(FIRST_TRACK.id);
            state.profile.xp = whole(state.profile.xp + FIRST_TRACK.xp, state.profile.xp, 10000000);
            state.profile.level = levelFor(state.profile.xp);
        }
        save(state);
        return true;
    }

    function untrack(game) {
        var id = toGameId(game);
        if (!id) return false;
        var state = fresh();
        var at = state.games.tracked.indexOf(id);
        if (at === -1) return true;
        state.games.tracked.splice(at, 1);
        save(state);
        return true;
    }

    /** Toggles, and reports what the game's state now is. */
    function toggleTracked(game) {
        var id = toGameId(game);
        if (!id) return false;
        // Decided from what is stored, so a game tracked in another tab is untracked here rather than
        // "tracked" a second time.
        if (fresh().games.tracked.indexOf(id) !== -1) { untrack(id); return false; }
        track(id);
        return true;
    }

    /** The arcade records, as the homepage card and the end-of-run screen read them. */
    function arcadeRecords() {
        var scope = load().arcade.resetScope;
        return {
            highScore: scope.highScore,
            highestMission: scope.highestMission,
            bestCombo: scope.bestCombo,
            bestRank: scope.bestRank,
            gamesPlayed: scope.gamesPlayed
        };
    }

    /**
     * Records a finished run, keeping only what beats what is already there.
     *
     * Returns which records the run broke, so the end-of-run screen can say so without asking again.
     */
    function recordRun(run) {
        var state = fresh();
        var scope = state.arcade.resetScope;
        var result = { newHighScore: false, newMission: false, newCombo: false, newRank: false };
        var data = run && typeof run === 'object' ? run : {};

        var score = whole(data.score, 0, 100000000);
        if (score > scope.highScore) { scope.highScore = score; result.newHighScore = true; }

        var mission = whole(data.mission, 0, 99);
        if (mission > scope.highestMission) { scope.highestMission = mission; result.newMission = true; }

        var combo = whole(data.combo, 0, 9999);
        if (combo > scope.bestCombo) { scope.bestCombo = combo; result.newCombo = true; }

        if (RANKS.indexOf(data.rank) > RANKS.indexOf(scope.bestRank)) {
            scope.bestRank = data.rank;
            result.newRank = true;
        }

        scope.gamesPlayed = whole(scope.gamesPlayed + 1, 1, 1000000);
        save(state);
        return result;
    }

    /**
     * Adds XP.
     *
     * Takes a reason, and refuses anything that is not a positive whole number, so "XP for loading the
     * page" cannot be written accidentally: what earns XP is a list decided in one place, not a number
     * any caller may pass. Returns the new profile.
     */
    function addXp(amount, reason) {
        var gain = whole(amount, 0, 100000);
        if (gain <= 0 || !reason) return profile();
        var state = fresh();
        state.profile.xp = whole(state.profile.xp + gain, state.profile.xp, 10000000);
        state.profile.level = levelFor(state.profile.xp);
        save(state);
        return profile();
    }

    function profile() {
        var state = load();
        return {
            xp: state.profile.xp,
            level: state.profile.level,
            xpToNext: xpToNextLevel(state.profile.xp)
        };
    }

    function hasAchievement(id) {
        return load().achievements.indexOf(id) !== -1;
    }

    /** Grants an achievement once. Returns whether this call was the one that granted it. */
    function grantAchievement(id) {
        if (typeof id !== 'string' || !id) return false;
        var state = fresh();
        if (state.achievements.indexOf(id) !== -1) return false;
        state.achievements.push(id);
        save(state);
        return true;
    }

    /** Drops the in-memory copy, so the next read comes from storage. For tests and for a fresh tab. */
    function forget() {
        cache = null;
    }

    /**
     * What the header's chip says, or null when it should say nothing.
     *
     * Pure, so the one piece of wording every page shares is written once and can be tested without a
     * DOM. Null until there is XP: a visitor who has never played is not "Level 1" with nothing to show
     * for it, they are someone this site knows nothing about, and saying so is the honest state.
     */
    function chipText() {
        var state = load();
        if (!state.profile.xp) return null;
        return 'LVL ' + state.profile.level + ' · ' + state.profile.xp.toLocaleString() + ' XP';
    }

    /**
     * Fills the header's chip, where the page has one.
     *
     * The only DOM this file touches, and deliberately: the chip is the one view of this record that
     * all seventeen pages share, and duplicating it into app.js and scope-play.js would be the same
     * wording in two places waiting to disagree. Every other view stays with the page that owns it.
     */
    function paintChip() {
        if (typeof document === 'undefined' || !document.getElementById) return false;
        var node = document.getElementById(CHIP_ID);
        if (!node) return false;
        var text = chipText();
        if (!text) {
            node.hidden = true;
            return false;
        }
        node.textContent = text;
        node.hidden = false;
        return true;
    }

    global.NextResetPlayer = {
        KEY: KEY,
        VERSION: VERSION,
        GAME_IDS: GAME_IDS.slice(),
        LEVEL_THRESHOLDS: LEVEL_THRESHOLDS.slice(),
        RANKS: RANKS.slice(),
        LEGACY_KEYS: { tracked: LEGACY_TRACKED, arcade: LEGACY_ARCADE },
        defaults: defaults,
        load: load,
        save: save,
        forget: forget,
        toGameId: toGameId,
        trackedGames: trackedGames,
        isTracked: isTracked,
        track: track,
        untrack: untrack,
        toggleTracked: toggleTracked,
        arcadeRecords: arcadeRecords,
        recordRun: recordRun,
        profile: profile,
        addXp: addXp,
        levelFor: levelFor,
        xpToNextLevel: xpToNextLevel,
        hasAchievement: hasAchievement,
        grantAchievement: grantAchievement,
        chipText: chipText,
        paintChip: paintChip,
        CHIP_ID: CHIP_ID,
        FIRST_TRACK: { id: FIRST_TRACK.id, xp: FIRST_TRACK.xp },
        // Whether a change made now will still be here on the next visit. Not the same question as whether
        // the stored record can be read: a full quota or Safari's private mode reads fine and refuses writes.
        storageAvailable: function () { return !!storage() && writable; }
    };

    // Reading once on load is what performs the migration, so a visitor who tracked games in the
    // prototype keeps them from the first page they open, rather than from the first page that asks.
    // Painting here rather than from each page's own script means the header fills on About and the
    // 404 too, which carry no other script at all.
    if (typeof document !== 'undefined') {
        load();
        paintChip();
        // Another tab wrote the record. Drop this page's copy so the next read is the real one, and
        // repaint the one view every page shares. (A null key means storage was cleared altogether.)
        if (global.addEventListener) {
            global.addEventListener('storage', function (event) {
                if (event && event.key !== KEY && event.key !== null) return;
                cache = null;
                paintChip();
            });
        }
    }
})(typeof window !== 'undefined' ? window : this);
