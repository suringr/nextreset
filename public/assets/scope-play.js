/**
 * RESET//SCOPE — wiring the game to the page.
 *
 * The loop, the input, the HUD and the overlays. Loaded only on /play/, after scope-core.js (the rules)
 * and scope.js (the board).
 *
 * Every listener that reads a key is bound to the stage, never the document. The page has a header, a
 * footer and several paragraphs of prose the reader is meant to scroll through; a global Space handler
 * would fire the signature mechanic instead of scrolling, which is what the prototype did.
 */
(function (global) {
    'use strict';

    var core = global.ResetScopeCore;
    var game = global.ResetScope;
    var document = global.document;
    if (!core || !game || !document) return;

    var stage = document.getElementById('stage');
    var canvas = document.getElementById('board');
    if (!stage || !canvas) return;

    var reducedMotion = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    var renderer = game.createRenderer(canvas, { reducedMotion: reducedMotion });
    var player = global.NextResetPlayer;

    var el = {
        score: document.getElementById('hud-score'),
        lives: document.getElementById('hud-lives'),
        ammo: document.getElementById('hud-ammo'),
        combo: document.getElementById('hud-combo'),
        mission: document.getElementById('hud-mission'),
        objective: document.getElementById('hud-objective'),
        objectiveLabel: document.getElementById('hud-objective-label'),
        clock: document.getElementById('hud-clock'),
        meter: document.getElementById('hud-meter'),
        scope: document.getElementById('control-scope'),
        cover: document.getElementById('control-cover'),
        reset: document.getElementById('control-reset'),
        pause: document.getElementById('control-pause'),
        overlay: document.getElementById('overlay'),
        overlayTitle: document.getElementById('overlay-title'),
        overlayBody: document.getElementById('overlay-body'),
        overlayAction: document.getElementById('overlay-action'),
        live: document.getElementById('game-status')
    };

    var playBlock = document.querySelector('.play');
    var run = null;
    var frame = 0;
    var last = 0;
    /** Touch gets toggles, a pointer gets holds. Decided per input event, not per device guess. */
    var lastInputWasTouch = false;

    // ─────────────────────────────── overlays ───────────────────────────────

    /**
     * The overlay is rendered from data every time it opens.
     *
     * The prototype overwrote its own start screen's text when a run ended, so the controls were gone
     * from the second run onward and never came back.
     */
    function showOverlay(title, body, actionLabel, action) {
        el.overlayTitle.textContent = title;
        el.overlayBody.innerHTML = '';
        for (var i = 0; i < body.length; i++) {
            var p = document.createElement('p');
            p.textContent = body[i];
            el.overlayBody.appendChild(p);
        }
        el.overlayAction.textContent = actionLabel;
        el.overlayAction.onclick = action;
        el.overlay.hidden = false;
        el.overlayAction.focus();
        announce(title);
    }

    function hideOverlay() {
        el.overlay.hidden = true;
    }

    function announce(text) {
        if (el.live) el.live.textContent = text;
    }

    function startScreen() {
        showOverlay('RESET//SCOPE', [
            'Five missions. Confirm targets, protect everyone else.',
            'Tap or click a contact to fire. SCOPE trades the edges of the board for precision. COVER reloads fast and stops incoming fire, but you cannot shoot from it. Skill charges RESET MODE, which slows time.',
            'Keyboard: arrows or WASD to aim, F or Enter to fire, Shift to scope, C for cover, Space for RESET MODE, P to pause.'
        ], 'Start run', startRun);
    }

    /** An achievement's readable title, from the same table the page prints. */
    function titleOf(id) {
        for (var i = 0; i < core.ACHIEVEMENTS.length; i++) {
            if (core.ACHIEVEMENTS[i].id === id) return core.ACHIEVEMENTS[i].title;
        }
        return id;
    }

    /** What one XP award is worth, so a screen can quote it without hardcoding the number. */
    function xpFor(id) {
        for (var i = 0; i < core.XP_AWARDS.length; i++) {
            if (core.XP_AWARDS[i].id === id) return core.XP_AWARDS[i].xp;
        }
        return 0;
    }

    /**
     * The screen between missions.
     *
     * Clearing a mission used to go straight to the next brief, so clearing one felt exactly like not
     * clearing one. It now says what was just achieved — and whether it was perfect — before it says
     * what is next.
     */
    function briefScreen() {
        var m = game.mission(run);
        var done = run.lastMission;
        if (done) {
            showOverlay(done.perfect ? done.name + ' — PERFECT' : done.name + ' cleared', [
                done.perfect
                    ? 'No life lost and no shot missed. That is worth ' + xpFor('perfect-mission') + ' XP on top of the mission itself.'
                    : 'Cleared in ' + done.seconds.toFixed(1) + ' seconds'
                        + (done.misses ? ', with ' + done.misses + (done.misses === 1 ? ' miss' : ' misses') : '')
                        + (done.livesLost ? ' and ' + done.livesLost + (done.livesLost === 1 ? ' life' : ' lives') + ' lost' : '') + '.',
                'Next: ' + m.name + '. ' + m.brief,
                'Objective: ' + core.objectiveText(m, run.progress) + '. ' + m.seconds + ' seconds, '
                    + run.lives + (run.lives === 1 ? ' life' : ' lives') + ' left.'
            ], 'Begin ' + m.name, function () {
                run.lastMission = null;
                run.paused = false;
                hideOverlay();
                last = 0;
                focusStage();
            });
            return;
        }
        showOverlay(m.name, [
            m.brief,
            'Objective: ' + core.objectiveText(m, run.progress) + '.',
            'You have ' + m.seconds + ' seconds and ' + run.lives + (run.lives === 1 ? ' life' : ' lives') + ' left.'
        ], 'Begin ' + m.name, function () {
            run.paused = false;
            hideOverlay();
            last = 0;
            focusStage();
        });
    }

    function pauseScreen() {
        showOverlay('Paused', [
            'The run is waiting for you.',
            'Nothing moves and the clock is stopped until you resume.'
        ], 'Resume', function () {
            run.paused = false;
            hideOverlay();
            last = 0;
            focusStage();
        });
    }

    function endScreen() {
        var accuracy = run.fired ? Math.round((run.hits / run.fired) * 100) : 0;
        var rank = core.rankFor(run.score);
        var missionsCleared = run.missionIndex;
        var records = null;

        var summary = {
            score: run.score,
            missionsCleared: missionsCleared,
            perfectMissions: run.perfectMissions,
            bestCombo: run.bestCombo,
            fired: run.fired,
            hits: run.hits,
            hurtInnocents: run.hurtInnocents,
            newHighScore: false
        };
        var awarded = null;
        var unlocked = [];
        var profile = null;

        if (player) {
            records = player.recordRun({
                score: run.score,
                mission: missionsCleared,
                combo: run.bestCombo,
                rank: rank
            });
            summary.newHighScore = records.newHighScore;

            // XP for what was actually done, itemised from the ledger in scope-core.js. Nothing in that
            // table can be earned by loading a page, reloading one, or coming back to it.
            awarded = core.xpForRun(summary);
            for (var i = 0; i < awarded.items.length; i++) {
                player.addXp(awarded.items[i].xp, awarded.items[i].id);
            }
            var earned = core.achievementsFor(summary);
            for (var e = 0; e < earned.length; e++) {
                if (player.grantAchievement(earned[e])) unlocked.push(titleOf(earned[e]));
            }
            profile = player.profile();
            paintRecords();
        }

        var lines = [
            run.outcome,
            'Score ' + run.score.toLocaleString() + ' · rank ' + rank + ' · ' + missionsCleared
                + ' of ' + core.MISSIONS.length + ' missions cleared'
                + (run.perfectMissions ? ', ' + run.perfectMissions + ' of them perfect' : '') + '.',
            'Accuracy ' + accuracy + '% over ' + run.fired + ' shots, best combo ×' + run.bestCombo + '.',
            'Rank comes from the score alone: S at 26,000, A at 16,000, B at 9,000, C at 4,000.'
        ];
        if (summary.newHighScore) lines.push('NEW HIGH SCORE.');
        if (awarded) {
            // Shown itemised, so the number is explainable rather than something that just went up.
            var parts = [];
            for (var a = 0; a < awarded.items.length; a++) {
                var item = awarded.items[a];
                parts.push(item.why + (item.times > 1 ? ' ×' + item.times : '') + ' (+' + item.xp + ')');
            }
            lines.push('+' + awarded.total + ' XP — ' + parts.join('; ') + '.');
        }
        if (profile) {
            lines.push('Level ' + profile.level + ', ' + profile.xp.toLocaleString() + ' XP'
                + (profile.xpToNext !== null ? ', ' + profile.xpToNext + ' to the next.' : ', top of the curve.'));
        }
        if (unlocked.length) lines.push('Unlocked: ' + unlocked.join(', ') + '.');
        showOverlay('Run over', lines, 'Play again', startRun);
    }

    // ─────────────────────────────── the loop ───────────────────────────────

    var hud = {
        flash: function () {
            if (reducedMotion) return;
            stage.classList.add('is-hit');
            global.setTimeout(function () { stage.classList.remove('is-hit'); }, 160);
        },
        brief: briefScreen,
        finish: function () { /* handled after update, so the last frame draws first */ }
    };

    /**
     * Sizes the board from the space actually left over, and frames it.
     *
     * The board, the HUD, the meter and the control bar all have to be on screen together, because the
     * page must not scroll during a run — and the page has a breadcrumb, a heading and a paragraph
     * above them. A CSS guess at how much room that takes is wrong the moment a title wraps, so the
     * three fixed parts are measured and the board gets the remainder.
     */
    function fitStage() {
        if (!playBlock) return renderer.resize();
        var used = 0;
        var parts = playBlock.querySelectorAll('.hud, .meter, .controls');
        for (var i = 0; i < parts.length; i++) used += parts[i].getBoundingClientRect().height;
        // Gaps between those parts, plus a little air so the last control is not against the edge.
        used += 44;
        var available = Math.max(220, global.innerHeight - used);
        stage.style.maxHeight = Math.floor(available) + 'px';
        return renderer.resize();
    }

    /**
     * Focus without scrolling.
     *
     * The board has to hold focus for the keyboard controls to reach it, and focusing an element scrolls
     * it into view by default — which pulled the HUD off the top of the screen a moment after the game
     * had been framed, leaving the control bar below the fold on a desktop.
     */
    function focusStage() {
        try {
            stage.focus({ preventScroll: true });
        } catch (e) {
            stage.focus();
        }
    }

    /** Brings the whole game block into view once, when a run starts. Nothing scrolls after that. */
    function frameGame() {
        if (!playBlock || !playBlock.scrollIntoView) return;
        playBlock.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
    }

    function startRun() {
        run = game.createRun((Date.now() ^ 0x9e3779b9) >>> 0);
        run.aim = { x: core.WORLD.w / 2, y: core.WORLD.h / 2 };
        // The score to beat, read once, so the callout can fire the moment it is passed.
        run.bestBefore = player ? player.arcadeRecords().highScore : 0;
        run.beatenBest = false;
        run.pixelsPerUnit = fitStage();
        run.paused = false;
        hideOverlay();
        stage.classList.add('is-playing');
        focusStage();
        // Last, so nothing focuses or resizes after the game has been framed.
        frameGame();
        last = 0;
        if (!frame) frame = global.requestAnimationFrame(tick);
        announce(game.mission(run).name + '. ' + game.mission(run).brief);
    }

    function tick(timestamp) {
        frame = global.requestAnimationFrame(tick);
        if (!run) return;
        if (!last) last = timestamp;
        // Capped, so a tab that was backgrounded does not resolve a two-second step in one frame.
        var dt = Math.min(0.05, (timestamp - last) / 1000) || 0;
        last = timestamp;

        run.pixelsPerUnit = renderer.scaleOf();
        game.update(run, dt, hud);
        renderer.draw(run);
        paint();

        if (run.over && el.overlay.hidden) {
            stage.classList.remove('is-playing');
            endScreen();
        }
    }

    function paint() {
        var m = game.mission(run);
        el.score.textContent = run.score.toLocaleString();
        el.lives.textContent = run.lives > 0 ? '♥'.repeat(run.lives) : '—';
        el.ammo.textContent = run.inCover ? 'COVER' : Math.floor(run.ammo) + '/' + core.MAGAZINE;
        el.combo.textContent = '×' + run.combo;
        el.mission.textContent = m.name;
        el.objective.textContent = core.objectiveShort(m, run.progress);
        if (el.objectiveLabel) el.objectiveLabel.textContent = core.objectiveNoun(m);
        el.clock.textContent = Math.max(0, m.seconds - run.missionTime).toFixed(1) + 's';
        el.meter.style.width = run.charge + '%';
        el.reset.disabled = run.charge < 100;
        el.reset.textContent = run.charge >= 100 ? 'RESET ⚡' : 'RESET ' + Math.floor(run.charge) + '%';
        el.scope.setAttribute('aria-pressed', run.scoped ? 'true' : 'false');
        el.cover.setAttribute('aria-pressed', run.inCover ? 'true' : 'false');
        stage.classList.toggle('is-reset', run.resetFor > 0);
    }

    // ─────────────────────────────── input ───────────────────────────────

    /** A pointer position in world units. */
    function toWorld(event) {
        var box = canvas.getBoundingClientRect();
        var scale = box.width / core.WORLD.w;
        return {
            x: (event.clientX - box.left) / scale,
            y: (event.clientY - box.top) / scale
        };
    }

    canvas.addEventListener('pointermove', function (event) {
        if (!run || event.pointerType === 'touch') return;
        run.aim = toWorld(event);
    });

    canvas.addEventListener('pointerdown', function (event) {
        if (!run || run.over) return;
        lastInputWasTouch = event.pointerType === 'touch';
        event.preventDefault();
        var at = toWorld(event);
        run.aim = at;
        if (run.paused) return;
        game.fire(run, at.x, at.y, hud);
    });

    function setScope(on) {
        if (!run) return;
        run.scoped = !!on;
    }

    function setCover(on) {
        if (!run) return;
        run.inCover = !!on;
    }

    /**
     * A hold control on a pointer, a toggle on touch.
     *
     * Holding SCOPE with one hand while tapping contacts with the other is two-handed play. On touch the
     * same button latches, so the whole game is reachable with one thumb.
     */
    function bindHoldOrToggle(button, apply, isOn) {
        button.addEventListener('pointerdown', function (event) {
            event.preventDefault();
            lastInputWasTouch = event.pointerType === 'touch';
            if (lastInputWasTouch) apply(!isOn());
            else apply(true);
        });
        var release = function (event) {
            if (event && event.pointerType === 'touch') return;
            if (!lastInputWasTouch) apply(false);
        };
        button.addEventListener('pointerup', release);
        button.addEventListener('pointercancel', release);
        button.addEventListener('pointerleave', release);
        // Keyboard activation of the button itself toggles, since there is no hold to observe.
        button.addEventListener('keydown', function (event) {
            if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                apply(!isOn());
            }
        });
    }

    bindHoldOrToggle(el.scope, setScope, function () { return run && run.scoped; });
    bindHoldOrToggle(el.cover, setCover, function () { return run && run.inCover; });

    el.reset.addEventListener('click', function () {
        if (run) game.activateReset(run);
    });

    el.pause.addEventListener('click', function () {
        if (!run || run.over) return;
        run.paused = true;
        pauseScreen();
    });

    /** Keyboard aiming, so the game is playable without a pointer at all. */
    var held = {};
    var AIM_SPEED = 0.85;

    stage.addEventListener('keydown', function (event) {
        if (!run) return;
        var key = event.key.toLowerCase();
        if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].indexOf(key) >= 0) {
            held[key] = true;
            event.preventDefault();
            return;
        }
        if (key === 'shift') { setScope(true); event.preventDefault(); return; }
        if (key === 'c') { setCover(true); event.preventDefault(); return; }
        if (key === 'f' || key === 'enter') {
            event.preventDefault();
            if (!run.paused) game.fire(run, run.aim.x, run.aim.y, hud);
            return;
        }
        if (key === ' ') {
            // Bound to the stage, so Space still scrolls the prose below when the board is not focused.
            event.preventDefault();
            game.activateReset(run);
            return;
        }
        if (key === 'p') {
            event.preventDefault();
            if (!run.over) { run.paused = true; pauseScreen(); }
        }
    });

    stage.addEventListener('keyup', function (event) {
        var key = event.key.toLowerCase();
        delete held[key];
        if (key === 'shift') setScope(false);
        if (key === 'c') setCover(false);
    });

    /** The crosshair moves while a key is held, in world units per second. */
    global.setInterval(function () {
        if (!run || run.paused || run.over) return;
        var dx = (held.arrowright || held.d ? 1 : 0) - (held.arrowleft || held.a ? 1 : 0);
        var dy = (held.arrowdown || held.s ? 1 : 0) - (held.arrowup || held.w ? 1 : 0);
        if (!dx && !dy) return;
        run.aim.x = Math.max(0, Math.min(core.WORLD.w, run.aim.x + dx * AIM_SPEED / 60));
        run.aim.y = Math.max(0, Math.min(core.WORLD.h, run.aim.y + dy * AIM_SPEED / 60));
    }, 1000 / 60);

    // ─────────────────────────────── pausing ───────────────────────────────

    /**
     * A run never continues while nobody is looking at it, and never resumes on its own.
     *
     * Backgrounding the tab, rotating the device or resizing the board all stop the clock. Resuming is
     * an explicit tap, because coming back to a run already in progress is how lives get lost to
     * nothing.
     */
    function interrupt() {
        if (!run || run.over || run.paused) return;
        run.paused = true;
        pauseScreen();
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) interrupt();
    });
    global.addEventListener('blur', interrupt);

    // The records panel is this page's view of the player record. player.js has already re-read the
    // record by the time these run (it is loaded first), so repainting is all that is left: after a
    // back-forward restore, and when another tab changes the record while this one is open.
    global.addEventListener('pageshow', function (event) {
        if (event && event.persisted) paintRecords();
    });
    global.addEventListener('storage', function (event) {
        if (!event || event.key === null || (player && event.key === player.KEY)) paintRecords();
    });
    global.addEventListener('orientationchange', function () {
        interrupt();
        global.setTimeout(function () { if (run) run.pixelsPerUnit = fitStage(); }, 250);
    });

    var resizeTimer = 0;
    global.addEventListener('resize', function () {
        global.clearTimeout(resizeTimer);
        resizeTimer = global.setTimeout(function () {
            var scale = fitStage();
            if (run) run.pixelsPerUnit = scale;
            if (run && !run.over) renderer.draw(run);
        }, 120);
    });

    // ─────────────────────────────── records on the page ───────────────────────────────

    function paintRecords() {
        if (!player) return;
        // The header's chip is the same record seen from every other page, so it moves when this does.
        // Without this a run would earn XP that only appeared after a reload.
        if (player.paintChip) player.paintChip();
        var records = player.arcadeRecords();
        var map = {
            'record-score': records.highScore ? records.highScore.toLocaleString() : '0',
            'record-mission': String(records.highestMission),
            'record-rank': records.bestRank || '—',
            'record-played': String(records.gamesPlayed),
            'record-level': String(player.profile().level),
            'record-xp': player.profile().xp.toLocaleString()
        };
        for (var id in map) {
            var node = document.getElementById(id);
            if (node) node.textContent = map[id];
        }
        // The achievement list is authored on the page, with what each one asks for. This only marks
        // which are earned, so the page reads the same with or without a record behind it.
        for (var a = 0; a < core.ACHIEVEMENTS.length; a++) {
            var row = document.querySelector('[data-achievement="' + core.ACHIEVEMENTS[a].id + '"]');
            if (!row) continue;
            var got = player.hasAchievement(core.ACHIEVEMENTS[a].id);
            row.setAttribute('data-earned', got ? '1' : '');
            var mark = row.querySelector('.achievement-state');
            if (mark) mark.textContent = got ? 'Earned' : 'Locked';
        }
    }

    // ─────────────────────────────── boot ───────────────────────────────

    fitStage();
    paintRecords();
    startScreen();
    // A still board behind the start overlay, so the page does not open on an empty rectangle.
    var idle = game.createRun(1);
    idle.aim = { x: core.WORLD.w / 2, y: core.WORLD.h * 0.55 };
    idle.pixelsPerUnit = renderer.scaleOf();
    renderer.draw(idle);

    global.ResetScopePlay = {
        startRun: startRun,
        current: function () { return run; },
        records: paintRecords
    };
})(typeof window !== 'undefined' ? window : this);
