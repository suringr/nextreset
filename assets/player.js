/**
 * NextReset — local player state.
 *
 * One versioned record under one key, `nextreset.player.v1`, holding everything the site remembers
 * about a visitor: which games they track, and their ONE SHOT progress — XP, the contracts unlocked, the
 * stars on each. There is no account and no server; this is deliberately all of it.
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
    /**
     * The record's format, not the key's name. 2 since ONE SHOT: version 1 of this file rebuilt the whole
     * record from its own defaults on every write, so a tab left open across the release — or a rollback —
     * would have deleted `arcade.oneShot` the first time it saved. A version-1 page treats a version-2
     * record as one from the future: it reads what it understands and never writes over it.
     */
    var VERSION = 2;

    /**
     * The tracked-games key written by the V4 prototype, read once and then left alone.
     *
     * Never deleted. A visitor who has the prototype open in another tab would otherwise lose their list
     * to whichever tab wrote last, and a rollback of this release would land on empty storage. Migration
     * is therefore additive and repeatable: reading it twice produces the same result.
     */
    var LEGACY_TRACKED = 'nrTracked';

    /** The element the shared header gives this file to fill. Kept in step by chrome.test.ts. */
    var CHIP_ID = 'chrome-player';

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

    /** ONE SHOT has eighty contracts; the game resumes at the highest one unlocked. */
    var CONTRACTS = 80;

    /**
     * ONE SHOT's ranks, one every 8,000 XP, exactly as the game names them.
     *
     * one-shot.js keeps its own copy — it is the approved prototype, word for word — and one-shot.test.ts
     * holds the two together, so the header can never call a player something the game would not.
     */
    var RANKS = ['Recruit', 'Rookie', 'Marksman', 'Sharpshooter', 'Hunter', 'Operative', 'Elite', 'Ghost', 'Master Sniper'];
    var RANK_XP = 8000;

    /**
     * Ceilings for stored numbers. High enough that no real play reaches them — a streak clear at contract
     * 80 is worth about 100,000 XP and a perfect run of all eighty about four million — and low enough that
     * every value stays an exact integer.
     */
    var MAX_XP = 1e12;
    var MAX_SCORE = 1e12;

    /** RESET//SCOPE's ranks, only to validate a carried record: see `sanitise`. */
    var RESET_SCOPE_RANKS = ['D', 'C', 'B', 'A', 'S'];

    function noStars() {
        var stars = [];
        for (var i = 0; i < CONTRACTS; i++) stars.push(0);
        return stars;
    }

    function defaults() {
        return {
            version: VERSION,
            profile: { xp: 0 },
            games: { tracked: [] },
            arcade: {
                oneShot: { unlocked: 1, stars: noStars(), bestScore: 0 }
            }
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

    /**
     * The stored record, telling apart the two things readJson folds together: the key genuinely being
     * absent (null — cleared, or a first visit) and the read itself failing (undefined — storage became
     * unreachable mid-visit). The first may be acted on; the second says nothing about what is stored,
     * and treating it as a clear threw away a good record and could write defaults over it.
     *
     * A record that is there but will not parse is null, as before: it is unusable, and replacing it
     * with the defaults is a repair, not a loss.
     */
    function readRecord(store) {
        if (!store) return null;
        var raw;
        try {
            raw = store.getItem(KEY);
        } catch (e) {
            return undefined;
        }
        if (raw === null || raw === undefined || raw === '') return null;
        try {
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {
            return null;
        }
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

    /** The rank a given amount of XP has reached — the game's own rule, `ranks[min(8, floor(xp / 8000))]`. */
    function rankFor(xp) {
        return RANKS[Math.min(RANKS.length - 1, Math.floor(whole(xp, 0, MAX_XP) / RANK_XP))];
    }

    /** A stored list of ids, kept only where each is a short non-empty string, once. */
    function idList(value, limit) {
        return (Array.isArray(value) ? value : [])
            .filter(function (id) { return typeof id === 'string' && id.length > 0 && id.length <= 64; })
            .filter(function (id, i, all) { return all.indexOf(id) === i; })
            .slice(0, limit);
    }

    /** Eighty star counts, each 0 to 3, from whatever was stored. */
    function starsFrom(value) {
        var stars = noStars();
        if (!Array.isArray(value)) return stars;
        for (var i = 0; i < CONTRACTS; i++) stars[i] = whole(value[i], 0, 3);
        return stars;
    }

    /** Whatever was stored, made into a state this code is willing to use. */
    function sanitise(stored) {
        var state = defaults();
        if (!stored || typeof stored !== 'object') return state;

        var profile = stored.profile && typeof stored.profile === 'object' ? stored.profile : {};
        // XP a visitor already has stays theirs, wherever it was earned. The rank is derived from it and
        // never stored, so a console edit cannot make the two disagree.
        state.profile.xp = whole(profile.xp, 0, MAX_XP);

        var games = stored.games && typeof stored.games === 'object' ? stored.games : {};
        state.games.tracked = uniqueIds(Array.isArray(games.tracked) ? games.tracked : []);

        var arcade = stored.arcade && typeof stored.arcade === 'object' ? stored.arcade : {};
        var shot = arcade.oneShot && typeof arcade.oneShot === 'object' ? arcade.oneShot : {};
        state.arcade.oneShot = {
            unlocked: Math.max(1, whole(shot.unlocked, 1, CONTRACTS)),
            stars: starsFrom(shot.stars),
            bestScore: whole(shot.bestScore, 0, MAX_SCORE)
        };

        // Carried, never read. RESET//SCOPE's records, its achievements and the one-off awards are the
        // visitor's data from before ONE SHOT: nothing shows them any more, but a rollback of this release
        // has to find them where they were. Validated as before, and only kept where they exist.
        var scope = arcade.resetScope && typeof arcade.resetScope === 'object' ? arcade.resetScope : null;
        if (scope) {
            state.arcade.resetScope = {
                highScore: whole(scope.highScore, 0, 100000000),
                highestMission: whole(scope.highestMission, 0, 99),
                bestCombo: whole(scope.bestCombo, 0, 9999),
                bestRank: RESET_SCOPE_RANKS.indexOf(scope.bestRank) !== -1 ? scope.bestRank : null,
                gamesPlayed: whole(scope.gamesPlayed, 0, 1000000)
            };
        }
        var awarded = idList(profile.awarded, 50);
        if (awarded.length) state.profile.awarded = awarded;
        var achievements = idList(stored.achievements, 200);
        if (achievements.length) state.achievements = achievements;

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
     * Folds the prototype's tracked-games key into a state that does not have them yet.
     *
     * Only ever adds: a tracked game from the old key joins the list. So running this twice, or running
     * it after the visitor has tracked under the new key, cannot lose anything.
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

        return changed;
    }

    var cache = null;

    /** The current state. Reads storage once per page, then serves the same object. */
    function load() {
        if (cache) return cache;
        var store = storage();
        var stored = readRecord(store);
        if (stored === undefined) {
            // Storage cannot be read right now. This page cannot know what it would be writing over, so
            // it stops writing and works from memory for the rest of the visit.
            writable = false;
            stored = null;
        }
        var state = sanitise(stored);

        // A record written by a later version of the site is left exactly where it is. Rolling a release
        // back must not cost a visitor their progress, so this version reads what it understands and
        // never writes over what it does not.
        var future = stored && whole(stored.version, VERSION) > VERSION;
        state.fromFuture = !!future;

        if (!future && writable) {
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
     * there, a contract cleared there. So every change starts from what is stored, and falls back to memory
     * only where storage could not take the write anyway.
     */
    /**
     * Whether this page's copy may hold changes that storage does not.
     *
     * True when there is no storage at all (disabled, or its getter throws), when writes are failing (a
     * full quota, private mode), and when the stored record belongs to a later version of the site,
     * which this version never writes over. In each, memory holds the only copy of what the visitor did
     * this session, and must not be replaced by what storage says.
     */
    function memoryHoldsChanges() {
        return !storage() || !writable || !!(cache && cache.fromFuture);
    }

    /**
     * Brings this page's copy in line with storage — replacing it only once a read has succeeded.
     *
     * The one place the cache is refreshed from storage, so a change about to be written (fresh) and a
     * resync after another tab or a back-forward restore (refresh) cannot disagree about what a failed
     * read means. Dropping the copy first and reading second lost everything the page held whenever
     * that read then threw.
     *
     *   - read:    the stored record replaces the copy.
     *   - cleared: the key is genuinely gone; the copy is dropped and the next read starts over.
     *   - failed:  storage cannot be read; the copy is kept and writing stops, because this page can no
     *              longer see what it would overwrite.
     */
    function reread() {
        var store = storage();
        if (!store) return 'failed';
        var stored = readRecord(store);
        if (stored === undefined) {
            writable = false;
            return 'failed';
        }
        if (stored === null) {
            cache = null;
            return 'cleared';
        }
        var state = sanitise(stored);
        state.fromFuture = whole(stored.version, VERSION) > VERSION;
        cache = state;
        return 'read';
    }

    function fresh() {
        if (!memoryHoldsChanges()) reread();
        return load();
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
        // Tracking earns no XP. It did, once, for a ledger RESET//SCOPE printed; ONE SHOT is where XP comes
        // from now, and XP already granted for it stays.
        state.games.tracked.push(id);
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

    /**
     * ONE SHOT's progress, as the game, the homepage card and the header read it. A copy: changing it
     * changes nothing stored.
     */
    function oneShot() {
        var state = load();
        var shot = state.arcade.oneShot;
        var stars = shot.stars.slice();
        var starsTotal = 0;
        var cleared = 0;
        for (var i = 0; i < stars.length; i++) {
            starsTotal += stars[i];
            if (stars[i] > 0) cleared++;
        }
        return {
            contracts: CONTRACTS,
            unlocked: shot.unlocked,
            stars: stars,
            starsTotal: starsTotal,
            cleared: cleared,
            bestScore: shot.bestScore,
            xp: state.profile.xp,
            rank: rankFor(state.profile.xp)
        };
    }

    /**
     * A contract cleared: the prototype's three writes, as one.
     *
     * The approved game wrote `nrStar<n>`, `nrXP` and `nrUnlocked` in that order on every clear; this is
     * the same arithmetic — the best stars kept, the points added to XP, the next contract unlocked, never
     * past the eightieth — landing in one record in one write, so another tab can never see two of the
     * three. `contract` counts from 1, as the game's LEVEL line does.
     */
    function recordContract(contract, points, stars) {
        var n = whole(contract, 0, CONTRACTS);
        if (n < 1) return false;
        var state = fresh();
        var shot = state.arcade.oneShot;
        shot.stars[n - 1] = Math.max(shot.stars[n - 1], whole(stars, 0, 3));
        state.profile.xp = whole(state.profile.xp + whole(points, 0, MAX_XP), state.profile.xp, MAX_XP);
        shot.unlocked = Math.max(shot.unlocked, Math.min(CONTRACTS, n + 1));
        save(state);
        return true;
    }

    /**
     * All eighty cleared in one sitting: the run's score, kept where it beats the best. The prototype's
     * `nrSniperBest`, written at the same moment and never shown by the game itself.
     */
    function recordFinish(score) {
        var state = fresh();
        var value = whole(score, 0, MAX_SCORE);
        if (value <= state.arcade.oneShot.bestScore) return false;
        state.arcade.oneShot.bestScore = value;
        save(state);
        return true;
    }

    function profile() {
        var state = load();
        return { xp: state.profile.xp, rank: rankFor(state.profile.xp) };
    }

    /** Drops the in-memory copy, so the next read comes from storage. For tests and for a fresh tab. */
    function forget() {
        cache = null;
    }

    /**
     * Re-reads storage on the next access, so changes made in another tab (or before a back-forward
     * restore) show up — unless this page holds changes storage could not take, which would be thrown
     * away by it. `forget()` drops the copy unconditionally, and is for tests.
     */
    function refresh() {
        if (!memoryHoldsChanges()) reread();
    }

    /**
     * What the header's chip says, or null when it should say nothing.
     *
     * A compact identity — rank and XP, `MARKSMAN · 18,240 XP` — and nothing more. The contract, the
     * stars and the score are the game's detail, and they live on the homepage card and on /play/, not in
     * the navigation every page shares. Null until there is XP: a visitor who has never played is not a
     * Recruit with nothing to show for it, they are someone this site knows nothing about.
     */
    function chipText() {
        var state = load();
        if (!state.profile.xp) return null;
        return rankFor(state.profile.xp).toUpperCase() + ' · ' + state.profile.xp.toLocaleString() + ' XP';
    }

    /**
     * Fills the header's chip, where the page has one.
     *
     * The only DOM this file touches, and deliberately: the chip is the one view of this record that
     * all seventeen pages share, and duplicating it into app.js and one-shot.js would be the same
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
        CONTRACTS: CONTRACTS,
        RANKS: RANKS.slice(),
        RANK_XP: RANK_XP,
        LEGACY_KEYS: { tracked: LEGACY_TRACKED },
        defaults: defaults,
        load: load,
        save: save,
        forget: forget,
        refresh: refresh,
        toGameId: toGameId,
        trackedGames: trackedGames,
        isTracked: isTracked,
        track: track,
        untrack: untrack,
        toggleTracked: toggleTracked,
        oneShot: oneShot,
        recordContract: recordContract,
        recordFinish: recordFinish,
        rankFor: rankFor,
        profile: profile,
        chipText: chipText,
        paintChip: paintChip,
        CHIP_ID: CHIP_ID,
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
                refresh();
                paintChip();
            });
            // A page restored from the back-forward cache runs no load handler, and every page that loads
            // this file shows the chip — including /play/, About, Privacy and the 404, which load no
            // app.js. Resyncing here rather than in app.js reaches all of them; a page with more of the
            // record on it (the homepage, /play/) repaints the rest itself after this has run.
            global.addEventListener('pageshow', function (event) {
                if (!event || !event.persisted) return;
                refresh();
                paintChip();
            });
        }
    }
})(typeof window !== 'undefined' ? window : this);
