/**
 * RESET//SCOPE — the rules, with no canvas and no DOM.
 *
 * Everything in this file is a pure function or a plain state machine, so the game's rules can be
 * tested in Node against a fixed seed rather than by playing it. The drawing, the input handling and
 * the page wiring live in scope.js and depend on this; nothing here depends on them.
 *
 * Why two plain scripts rather than ES modules: `_headers` serves /assets/*.js immutable for a year and
 * the build appends a content hash to every asset URL it finds in the HTML. It does not rewrite `import`
 * specifiers inside a JavaScript file, so a module importing "./engine.js" would be cached for a year at
 * an unversioned URL — which is the exact bug asset-cache.test.ts exists to prevent. Two hashed files
 * referenced from the page keep that contract intact.
 *
 * ── The world ──
 * Positions and sizes are in world units, not pixels: the board is 1 wide and 1.25 tall, a 4:5 portrait.
 * The renderer scales that to whatever the device gives it. The prototype worked in a fixed 960×540
 * pixel space and stretched it into a square on phones, so every circle drew as an ellipse.
 */
(function (global) {
    'use strict';

    /** The board: 4 wide by 5 tall, in world units. */
    var WORLD = { w: 1, h: 1.25 };

    /**
     * The smallest target a finger can reliably hit, per WCAG 2.5.5, in CSS pixels.
     *
     * Hit radius floors at half of it whatever the drawing does, so difficulty comes from exposure,
     * identification, movement and timing — never from a target too small to touch. The prototype's
     * sniper targets rendered about 9-13px across on a 390px screen.
     */
    var MIN_TAP_PX = 44;

    /** Combo stops here. Uncapped, one late hit in RESET mode was worth more than a whole mission. */
    var COMBO_CAP = 8;

    /** RESET mode multiplies score by this and no more: it earns its place by changing time, not points. */
    var RESET_SCORE_MULTIPLIER = 1.5;

    /** How long RESET mode lasts, and how far it slows the world. */
    var RESET_SECONDS = 4.5;
    var RESET_TIME_SCALE = 0.45;

    /** Reload rates, per second. Cover is faster; outside it you are not stranded, only slower. */
    var RELOAD_IN_COVER = 2.8;
    var RELOAD_EXPOSED = 0.62;
    var MAGAZINE = 6;

    /** Lives, and the shot clock's grace: a mission is failed by its objective, not by a stopwatch. */
    var LIVES = 3;

    // ─────────────────────────────── random ───────────────────────────────

    /**
     * A seeded generator, so a run is reproducible.
     *
     * Every random decision the game makes comes through one of these. That makes the rules testable,
     * and it is what would let a Daily Contract give everyone the same run from a date seed without any
     * server — which is why it is here now rather than later.
     */
    function createRng(seed) {
        var state = (seed >>> 0) || 1;
        function next() {
            state = (state + 0x6D2B79F5) >>> 0;
            var t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
        return {
            /** 0 ≤ n < 1 */
            next: next,
            /** a ≤ n < b */
            between: function (a, b) { return a + next() * (b - a); },
            /** true with probability p */
            chance: function (p) { return next() < p; },
            /** one of the items */
            pick: function (items) { return items[Math.floor(next() * items.length)]; }
        };
    }

    // ─────────────────────────────── missions ───────────────────────────────

    /**
     * Five missions, each with its own rules rather than its own label.
     *
     * A mission ends when its objective is met, not when a clock runs out. In the prototype every
     * mission ran for twenty seconds and then advanced whatever the player did, so a player who never
     * fired still reached the boss. The clock is now a failure condition, not a conveyor belt.
     */
    var MISSIONS = [
        {
            id: 'quick-draw',
            name: 'QUICK DRAW',
            brief: 'Confirm targets before they break contact. Civilians cost a life.',
            objective: { confirms: 8 },
            seconds: 28,
            // Exposure narrows as the mission progresses: the pressure comes from the window, not speed.
            expose: [1.6, 0.85],
            spawnEvery: [0.55, 1.1],
            concurrent: 2,
            size: [0.055, 0.075],
            targetChance: 0.7,
            hostages: false,
            incomingFire: false,
            lanes: 0
        },
        {
            id: 'hostage',
            name: 'HOSTAGE',
            brief: 'A hostage is held on one side. Shoot the other side.',
            objective: { saves: 5 },
            seconds: 40,
            expose: [2.4, 1.5],
            spawnEvery: [0.9, 1.5],
            concurrent: 2,
            size: [0.075, 0.095],
            targetChance: 0.8,
            hostages: true,
            incomingFire: false,
            lanes: 0
        },
        {
            id: 'sniper',
            name: 'SNIPER',
            brief: 'Distant contacts. Scope to tell them apart — you will lose the edges of the board.',
            objective: { confirms: 6 },
            seconds: 38,
            expose: [2.6, 1.7],
            spawnEvery: [1.0, 1.7],
            concurrent: 3,
            // Drawn small. The hit area never goes below a finger's width, so this is an
            // identification problem, not a dexterity one.
            size: [0.022, 0.032],
            targetChance: 0.55,
            hostages: false,
            incomingFire: false,
            lanes: 0
        },
        {
            id: 'crossfire',
            name: 'CROSSFIRE',
            brief: 'Three lanes moving at once, and civilians cross in front. They shoot back — take cover.',
            objective: { confirms: 10 },
            seconds: 45,
            expose: [3.2, 2.2],
            spawnEvery: [0.5, 0.9],
            concurrent: 5,
            size: [0.05, 0.068],
            targetChance: 0.5,
            hostages: false,
            incomingFire: true,
            lanes: 3
        },
        {
            id: 'boss',
            name: 'BOSS',
            brief: 'Armoured and behind cover. It exposes, you fire, it answers. Three phases.',
            objective: { phases: 3 },
            seconds: 60,
            expose: [1.5, 1.0],
            spawnEvery: [0, 0],
            concurrent: 1,
            size: [0.1, 0.12],
            targetChance: 1,
            hostages: false,
            incomingFire: true,
            lanes: 0
        }
    ];

    // ─────────────────────────────── geometry ───────────────────────────────

    /**
     * The hit radius for an actor, in world units.
     *
     * Three things widen it, and all of them are earned: the scope trades away awareness for it, RESET
     * mode is charged by skill, and the tap floor is there so nothing is ever too small to hit.
     */
    function hitRadius(actor, options) {
        var o = options || {};
        var scale = o.pixelsPerUnit || 0;
        var floor = scale > 0 ? (MIN_TAP_PX / 2) / scale : 0;
        var r = Math.max(actor.r, floor);
        if (o.scoped) r *= 1.35;
        if (o.resetMode) r *= 1.3;
        return r;
    }

    /** Distance between a shot and an actor's centre, in world units. */
    function distanceTo(actor, x, y) {
        var dx = x - actor.x;
        var dy = y - actor.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Whether a shot at (x, y) struck the hostage rather than the target.
     *
     * The hostage occupies an arc on one side of the actor, and the test is against THAT ARC — the side
     * the hostage is actually drawn on. The prototype drew the hostage to the right and then tested
     * radial distance, so a shot on the empty left edge killed the hostage. A player cannot learn a
     * rule the code does not implement.
     */
    function hitsHostage(actor, x, y) {
        if (!actor.hostage) return false;
        var dx = x - actor.x;
        var dy = y - actor.y;
        var angle = Math.atan2(dy, dx);
        var delta = Math.abs(normaliseAngle(angle - actor.hostage.angle));
        return delta <= actor.hostage.arc / 2;
    }

    /** An angle folded into −π…π, so two angles can be compared by their difference. */
    function normaliseAngle(angle) {
        var a = angle;
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        return a;
    }

    /**
     * Which actor a shot resolves against, and how cleanly.
     *
     * Only actors the player can actually see are candidates: scoping narrows the board to the scope
     * circle, and an actor outside it is neither drawn nor hittable. That is the whole cost of the
     * scope — precision bought with awareness — and it is enforced here rather than being a promise the
     * renderer makes on its own.
     */
    function resolveShot(actors, x, y, options) {
        var o = options || {};
        var best = null;
        var bestDistance = Infinity;
        for (var i = 0; i < actors.length; i++) {
            var actor = actors[i];
            if (actor.hidden || actor.dead) continue;
            if (o.scoped && o.scope) {
                var fromCentre = Math.sqrt(Math.pow(actor.x - o.scope.x, 2) + Math.pow(actor.y - o.scope.y, 2));
                if (fromCentre > o.scope.r) continue;
            }
            var reach = hitRadius(actor, o);
            var d = distanceTo(actor, x, y);
            if (d <= reach && d < bestDistance) {
                bestDistance = d;
                best = actor;
            }
        }
        if (!best) return { kind: 'miss' };

        if (hitsHostage(best, x, y)) return { kind: 'hostage', actor: best, distance: bestDistance };
        if (best.kind === 'civilian') return { kind: 'civilian', actor: best, distance: bestDistance };

        var reachHit = hitRadius(best, o);
        // How central the shot was, 0 at the edge and 1 dead centre.
        var precision = reachHit > 0 ? Math.max(0, 1 - bestDistance / reachHit) : 0;
        return {
            kind: 'target',
            actor: best,
            distance: bestDistance,
            precision: precision,
            bullseye: precision >= 0.72
        };
    }

    // ─────────────────────────────── scoring ───────────────────────────────

    /**
     * What a confirmed target is worth.
     *
     * The prototype's combo ran to ×15 and RESET mode doubled on top, so one late bullseye hostage save
     * scored more than an entire early mission and the run's score said nothing about how it was played.
     * The combo caps at ×8 and RESET multiplies by 1.5, which leaves RESET worth using for what it
     * actually does — slowing time and widening the window — rather than for the multiplier.
     */
    function scoreForHit(hit, context) {
        var c = context || {};
        var base = 100;
        var precision = Math.round((hit.precision || 0) * 100);
        var quickshot = c.exposedFor !== undefined && c.exposedFor <= 0.5 ? 60 : 0;
        var bullseye = hit.bullseye ? 80 : 0;
        var save = hit.actor && hit.actor.hostage ? 200 : 0;
        var combo = Math.min(c.combo || 1, COMBO_CAP);
        var multiplier = c.resetMode ? RESET_SCORE_MULTIPLIER : 1;
        var subtotal = base + precision + quickshot + bullseye + save;
        return {
            points: Math.round(subtotal * combo * multiplier),
            events: [].concat(
                quickshot ? ['QUICKSHOT'] : [],
                bullseye ? ['BULLSEYE'] : [],
                save ? ['HOSTAGE SAVE'] : []
            )
        };
    }

    /** A multikill is three confirms inside this window, and is worth a flat bonus, not a multiplier. */
    var MULTIKILL_WINDOW = 1.6;
    var MULTIKILL_BONUS = 150;

    /** How much a hit charges the RESET meter. Skill charges it; time does not. */
    function chargeForHit(hit, context) {
        var c = context || {};
        var charge = 11;
        if (hit.bullseye) charge += 9;
        if (c.exposedFor !== undefined && c.exposedFor <= 0.5) charge += 6;
        if (hit.actor && hit.actor.hostage) charge += 12;
        return charge;
    }

    /**
     * The rank a finished run earns.
     *
     * Thresholds rather than a curve, so the end screen can state how it was worked out — a rank nobody
     * can explain is a number with a letter painted on it.
     */
    var RANK_THRESHOLDS = [
        { rank: 'S', score: 26000 },
        { rank: 'A', score: 16000 },
        { rank: 'B', score: 9000 },
        { rank: 'C', score: 4000 },
        { rank: 'D', score: 0 }
    ];

    function rankFor(score) {
        for (var i = 0; i < RANK_THRESHOLDS.length; i++) {
            if (score >= RANK_THRESHOLDS[i].score) return RANK_THRESHOLDS[i].rank;
        }
        return 'D';
    }

    // ─────────────────────────────── ammunition and cover ───────────────────────────────

    /**
     * Ammunition after a slice of time.
     *
     * Cover reloads quickly; outside it a magazine still refills, slowly. In the prototype ammunition
     * regenerated ONLY in cover, which made cover compulsory rather than tactical — and cover blacked
     * out the whole screen while the clock ran. Here it is a trade: reload faster and be safe, or stay
     * out and keep watching.
     */
    function reload(ammo, inCover, dt) {
        var rate = inCover ? RELOAD_IN_COVER : RELOAD_EXPOSED;
        return Math.min(MAGAZINE, ammo + rate * dt);
    }

    /** Whether a shot is allowed right now. Cover protects, and the price is that you cannot fire. */
    function canFire(state) {
        return !state.inCover && !state.paused && !state.over && state.ammo >= 1;
    }

    // ─────────────────────────────── objectives ───────────────────────────────

    /** Whether the mission's objective has been met. */
    function objectiveMet(mission, progress) {
        var o = mission.objective;
        if (o.confirms !== undefined) return (progress.confirms || 0) >= o.confirms;
        if (o.saves !== undefined) return (progress.saves || 0) >= o.saves;
        if (o.phases !== undefined) return (progress.phases || 0) >= o.phases;
        return false;
    }

    /**
     * The objective as a noun and a fraction, for the HUD.
     *
     * Split because a quarter-width cell cannot hold "0 / 8 confirmed" — it broke as "confirme/d" at
     * 390px and as "confirm/ed" at 1280px, since the cell is narrow at every size. The word belongs in
     * the label above the number, which is where the HUD puts every other unit.
     */
    function objectiveNoun(mission) {
        var o = mission.objective;
        if (o.confirms !== undefined) return 'Confirmed';
        if (o.saves !== undefined) return 'Saved';
        if (o.phases !== undefined) return 'Phase';
        return 'Objective';
    }

    function objectiveShort(mission, progress) {
        var o = mission.objective;
        if (o.confirms !== undefined) return (progress.confirms || 0) + '/' + o.confirms;
        if (o.saves !== undefined) return (progress.saves || 0) + '/' + o.saves;
        if (o.phases !== undefined) return Math.min((progress.phases || 0) + 1, o.phases) + '/' + o.phases;
        return '';
    }

    /** What the objective asks for, as a full sentence the mission brief can show. */
    function objectiveText(mission, progress) {
        var o = mission.objective;
        if (o.confirms !== undefined) return (progress.confirms || 0) + ' / ' + o.confirms + ' confirmed';
        if (o.saves !== undefined) return (progress.saves || 0) + ' / ' + o.saves + ' saved';
        if (o.phases !== undefined) return 'Phase ' + Math.min((progress.phases || 0) + 1, o.phases) + ' / ' + o.phases;
        return '';
    }

    /**
     * How far through a mission the player is, 0 to 1.
     *
     * Difficulty is driven from this rather than from elapsed time, so a fast player meets the narrow
     * exposure windows sooner and a slow one is not punished twice.
     */
    function missionProgress(mission, progress) {
        var o = mission.objective;
        var need = o.confirms || o.saves || o.phases || 1;
        var done = progress.confirms || progress.saves || progress.phases || 0;
        return Math.max(0, Math.min(1, done / need));
    }

    /** How long a contact stays exposed at this point in the mission. */
    function exposureFor(mission, progress) {
        var t = missionProgress(mission, progress);
        return mission.expose[0] + (mission.expose[1] - mission.expose[0]) * t;
    }

    global.ResetScopeCore = {
        WORLD: WORLD,
        MIN_TAP_PX: MIN_TAP_PX,
        COMBO_CAP: COMBO_CAP,
        RESET_SCORE_MULTIPLIER: RESET_SCORE_MULTIPLIER,
        RESET_SECONDS: RESET_SECONDS,
        RESET_TIME_SCALE: RESET_TIME_SCALE,
        MAGAZINE: MAGAZINE,
        RELOAD_IN_COVER: RELOAD_IN_COVER,
        RELOAD_EXPOSED: RELOAD_EXPOSED,
        LIVES: LIVES,
        MULTIKILL_WINDOW: MULTIKILL_WINDOW,
        MULTIKILL_BONUS: MULTIKILL_BONUS,
        RANK_THRESHOLDS: RANK_THRESHOLDS,
        MISSIONS: MISSIONS,
        createRng: createRng,
        hitRadius: hitRadius,
        distanceTo: distanceTo,
        hitsHostage: hitsHostage,
        normaliseAngle: normaliseAngle,
        resolveShot: resolveShot,
        scoreForHit: scoreForHit,
        chargeForHit: chargeForHit,
        rankFor: rankFor,
        reload: reload,
        canFire: canFire,
        objectiveMet: objectiveMet,
        objectiveText: objectiveText,
        objectiveNoun: objectiveNoun,
        objectiveShort: objectiveShort,
        missionProgress: missionProgress,
        exposureFor: exposureFor
    };
})(typeof window !== 'undefined' ? window : this);
