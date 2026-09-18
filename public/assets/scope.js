/**
 * RESET//SCOPE — the playable part: canvas, input, loop, HUD.
 *
 * The rules live in scope-core.js and are tested without a browser. This file draws them, listens for
 * input, and keeps the run's state. It loads only on /play/.
 *
 * Four things here exist because the prototype got them wrong on a phone:
 *
 *   The canvas is sized from its own box times the device pixel ratio, every time the box changes. The
 *   prototype had a fixed 960×540 buffer stretched into a square by mobile CSS, so every circle drew as
 *   an ellipse and every retina screen drew it blurry.
 *
 *   Positions are in world units (a 1 × 1.25 board) and scaled at draw time, so the same run plays the
 *   same on a 320px phone and a desktop.
 *
 *   Scope and Cover are toggles on touch and holds on a pointer. Holding a button while tapping targets
 *   with the other hand is two-handed play, and nobody arrives at a tracker site expecting that.
 *
 *   Keyboard listeners are bound to the stage, not the document. The prototype bound Space globally,
 *   so on a page with a header and a footer — which this one must have — pressing Space to scroll fired
 *   the signature mechanic instead.
 */
(function (global) {
    'use strict';

    var core = global.ResetScopeCore;
    if (!core) return;

    var W = core.WORLD.w;
    var H = core.WORLD.h;

    /** How much of the board the scope leaves you, in world units. The rest is what you give up. */
    var SCOPE_RADIUS = 0.3;

    /** How long a contact aims before it fires, and how long its telegraph is visible. */
    var AIM_SECONDS = 1.5;

    /** Boss timings: how long it exposes, and how long it stays behind cover answering. */
    var BOSS_EXPOSED = 1.5;
    var BOSS_COVERED = 2.2;

    function clamp(value, low, high) { return value < low ? low : value > high ? high : value; }

    // ─────────────────────────────── the run ───────────────────────────────

    function createRun(seed) {
        return {
            rng: core.createRng(seed),
            seed: seed,
            missionIndex: 0,
            progress: {},
            actors: [],
            shots: [],
            effects: [],
            score: 0,
            combo: 1,
            bestCombo: 1,
            lives: core.LIVES,
            ammo: core.MAGAZINE,
            charge: 0,
            resetFor: 0,
            confirms: 0,
            fired: 0,
            hits: 0,
            // Per-mission, for PERFECT: no life lost and no shot missed inside this mission.
            missionMisses: 0,
            missionLivesLost: 0,
            perfectMissions: 0,
            hurtInnocents: false,
            missionTime: 0,
            spawnIn: 0.4,
            recentHits: [],
            inCover: false,
            scoped: false,
            paused: false,
            over: false,
            outcome: '',
            nextActorId: 1,
            bossPhaseTime: 0,
            bossExposed: true
        };
    }

    function mission(run) { return core.MISSIONS[run.missionIndex]; }

    // ─────────────────────────────── actors ───────────────────────────────

    function spawn(run) {
        var m = mission(run);
        var rng = run.rng;
        var expose = core.exposureFor(m, run.progress);
        var size = rng.between(m.size[0], m.size[1]);
        var isTarget = m.id === 'boss' ? true : rng.chance(m.targetChance);

        var lane = 0;
        var y;
        var vx = 0;
        if (m.lanes > 0) {
            lane = Math.floor(rng.next() * m.lanes);
            y = 0.3 + lane * (0.55 / Math.max(1, m.lanes - 1));
            // Lanes move, and civilians move faster so they cross in front of targets.
            vx = (rng.chance(0.5) ? 1 : -1) * rng.between(0.07, 0.16) * (isTarget ? 1 : 1.35);
        } else {
            y = rng.between(0.28, 0.95);
        }

        var actor = {
            id: run.nextActorId++,
            kind: isTarget ? 'target' : 'civilian',
            x: m.lanes > 0 ? (vx > 0 ? -size : W + size) : rng.between(0.14, W - 0.14),
            y: y,
            r: size,
            vx: vx,
            lane: lane,
            born: 0,
            life: expose,
            hp: m.id === 'boss' ? 4 : 1,
            hidden: false,
            dead: false,
            occluded: false,
            hostage: null,
            aiming: 0,
            hasFired: false
        };

        if (m.hostages && isTarget && rng.chance(0.85)) {
            // The hostage is held on one side, and that side is where the test looks.
            actor.hostage = { angle: rng.pick([0, Math.PI, Math.PI / 2, -Math.PI / 2]), arc: Math.PI * 0.9 };
        }
        run.actors.push(actor);
    }

    function spawnBoss(run) {
        var m = mission(run);
        run.actors.push({
            id: run.nextActorId++,
            kind: 'target',
            boss: true,
            x: W / 2,
            y: 0.55,
            r: m.size[1],
            vx: 0.09,
            born: 0,
            life: Infinity,
            hp: 4,
            hidden: false,
            dead: false,
            occluded: false,
            hostage: null,
            aiming: 0,
            hasFired: false
        });
    }

    // ─────────────────────────────── update ───────────────────────────────

    function update(run, dt, hud) {
        if (run.paused || run.over) return;
        var m = mission(run);
        var slow = run.resetFor > 0 ? core.RESET_TIME_SCALE : 1;
        var step = dt * slow;

        if (run.resetFor > 0) run.resetFor = Math.max(0, run.resetFor - dt);
        run.ammo = core.reload(run.ammo, run.inCover, dt);
        run.missionTime += dt;

        if (run.missionTime >= m.seconds) {
            failMission(run, 'Out of time.');
            return;
        }

        if (m.id === 'boss') updateBoss(run, step);
        else {
            run.spawnIn -= step;
            var room = run.actors.filter(function (a) { return !a.dead; }).length < m.concurrent;
            if (run.spawnIn <= 0 && room) {
                spawn(run);
                run.spawnIn = run.rng.between(m.spawnEvery[0], m.spawnEvery[1]);
            }
        }

        for (var i = 0; i < run.actors.length; i++) {
            var a = run.actors[i];
            if (a.dead) continue;
            a.born += step;
            a.life -= step;
            a.x += a.vx * step;
            if (m.lanes === 0 && (a.x < a.r || a.x > W - a.r)) a.vx *= -1;

            // A contact left alive long enough takes aim, and only where the mission has incoming fire.
            if (m.incomingFire && a.kind === 'target' && !a.hasFired && a.born > AIM_SECONDS) {
                a.aiming += step;
                if (a.aiming >= AIM_SECONDS) {
                    a.hasFired = true;
                    a.aiming = 0;
                    incoming(run, a, hud);
                }
            }

            if (a.life <= 0 || (m.lanes > 0 && (a.x < -0.2 || a.x > W + 0.2))) {
                a.dead = true;
                // A target that broke contact is a missed opportunity, not a penalty: the objective is
                // what gates the mission, and the clock is the pressure.
                if (a.kind === 'target' && !a.boss) run.combo = 1;
            }
        }

        // Civilians crossing in front of a target hide it. That is Crossfire's whole problem: you can
        // see the contact and still not have a shot.
        for (var t = 0; t < run.actors.length; t++) {
            var target = run.actors[t];
            if (target.dead || target.kind !== 'target') continue;
            target.occluded = false;
            for (var c = 0; c < run.actors.length; c++) {
                var civ = run.actors[c];
                if (civ.dead || civ.kind !== 'civilian') continue;
                if (core.distanceTo(civ, target.x, target.y) < civ.r + target.r * 0.55) {
                    target.occluded = true;
                    break;
                }
            }
        }

        run.actors = run.actors.filter(function (a) { return !a.dead || a.fadeFor > 0; });
        for (var e = run.effects.length - 1; e >= 0; e--) {
            run.effects[e].life -= dt;
            if (run.effects[e].life <= 0) run.effects.splice(e, 1);
        }
        for (var s = run.shots.length - 1; s >= 0; s--) {
            run.shots[s].life -= dt;
            if (run.shots[s].life <= 0) run.shots.splice(s, 1);
        }

        if (core.objectiveMet(m, run.progress)) completeMission(run, hud);
    }

    function updateBoss(run, step) {
        var boss = run.actors.find(function (a) { return a.boss && !a.dead; });
        if (!boss) { spawnBoss(run); return; }
        run.bossPhaseTime += step;
        var window = run.bossExposed ? BOSS_EXPOSED : BOSS_COVERED;
        if (run.bossPhaseTime >= window) {
            run.bossPhaseTime = 0;
            run.bossExposed = !run.bossExposed;
            boss.hidden = !run.bossExposed;
            // Behind cover it answers, which is the pattern: expose, fire, cover, reload.
            if (!run.bossExposed) boss.hasFired = false;
        }
        boss.x = clamp(boss.x + boss.vx * step, boss.r, W - boss.r);
        if (boss.x <= boss.r || boss.x >= W - boss.r) boss.vx *= -1;
    }

    /** A contact fires. Cover is the answer; being caught out of it costs a life. */
    function incoming(run, actor, hud) {
        run.shots.push({ x: actor.x, y: actor.y, life: 0.45 });
        if (run.inCover) {
            say(run, 'BLOCKED', actor.x, actor.y, 'cover');
            return;
        }
        loseLife(run, 'HIT', hud);
    }

    function loseLife(run, label, hud) {
        run.lives -= 1;
        run.missionLivesLost += 1;
        run.combo = 1;
        say(run, label, W / 2, 0.5, 'bad');
        if (hud) hud.flash();
        if (run.lives <= 0) failMission(run, 'Out of lives.');
    }

    function say(run, text, x, y, tone) {
        run.effects.push({ text: text, x: x, y: y, tone: tone || 'good', life: 0.9 });
    }

    // ─────────────────────────────── firing ───────────────────────────────

    function fire(run, x, y, hud) {
        var m = mission(run);
        if (run.paused || run.over) return;
        if (run.inCover) { say(run, 'IN COVER', W / 2, 0.45, 'note'); return; }
        if (run.ammo < 1) { say(run, 'RELOADING', W / 2, 0.45, 'note'); return; }

        run.ammo -= 1;
        run.fired += 1;

        var options = {
            pixelsPerUnit: run.pixelsPerUnit,
            scoped: run.scoped,
            resetMode: run.resetFor > 0,
            scope: run.scoped ? { x: run.aim.x, y: run.aim.y, r: SCOPE_RADIUS } : null
        };
        // An occluded target is not a target you have a shot at.
        var candidates = run.actors.filter(function (a) { return !a.occluded || a.kind === 'civilian'; });
        var hit = core.resolveShot(candidates, x, y, options);

        if (hit.kind === 'miss') {
            run.combo = 1;
            run.missionMisses += 1;
            run.score = Math.max(0, run.score - 15);
            say(run, 'MISS', x, y, 'note');
            return;
        }

        if (hit.kind === 'hostage') {
            hit.actor.dead = true;
            run.hurtInnocents = true;
            say(run, 'HOSTAGE DOWN', hit.actor.x, hit.actor.y, 'bad');
            loseLife(run, '', hud);
            return;
        }

        if (hit.kind === 'civilian') {
            hit.actor.dead = true;
            run.hurtInnocents = true;
            say(run, 'CIVILIAN', hit.actor.x, hit.actor.y, 'bad');
            loseLife(run, '', hud);
            return;
        }

        run.hits += 1;
        var actor = hit.actor;
        var exposedFor = actor.born;
        actor.hp -= 1;

        var context = { combo: run.combo, resetMode: run.resetFor > 0, exposedFor: exposedFor };
        var scored = core.scoreForHit(hit, context);
        run.score += scored.points;
        run.charge = Math.min(100, run.charge + core.chargeForHit(hit, context));

        var now = run.missionTime;
        run.recentHits = run.recentHits.filter(function (t) { return now - t < core.MULTIKILL_WINDOW; });
        run.recentHits.push(now);
        if (run.recentHits.length >= 3) {
            run.score += core.MULTIKILL_BONUS;
            scored.events.push('MULTIKILL');
            run.recentHits = [];
        }

        if (actor.hp <= 0) {
            actor.dead = true;
            if (actor.boss) {
                run.progress.phases = (run.progress.phases || 0) + 1;
                if (!core.objectiveMet(mission(run), run.progress)) {
                    spawnBoss(run);
                    run.bossExposed = true;
                    run.bossPhaseTime = 0;
                }
            } else if (actor.hostage) {
                run.progress.saves = (run.progress.saves || 0) + 1;
                run.progress.confirms = (run.progress.confirms || 0) + 1;
            } else {
                run.progress.confirms = (run.progress.confirms || 0) + 1;
            }
            run.confirms += 1;
            var before = run.combo;
            run.combo = Math.min(core.COMBO_CAP, run.combo + 1);
            run.bestCombo = Math.max(run.bestCombo, run.combo);
            // Milestones only: a shout on every increment is noise, and noise on a board you are
            // reading is worse than no feedback at all.
            if (run.combo !== before && core.COMBO_MILESTONES.indexOf(run.combo) >= 0) {
                say(run, 'COMBO ×' + run.combo, W / 2, 0.2, 'brand');
            }
        }

        // Beating your own best is worth knowing while it still matters, not only on the end screen.
        if (!run.beatenBest && run.bestBefore > 0 && run.score > run.bestBefore) {
            run.beatenBest = true;
            say(run, 'NEW HIGH SCORE', W / 2, 0.24, 'good');
        }

        var label = scored.events.length ? scored.events.join(' · ') : '+' + scored.points;
        say(run, label, actor.x, actor.y, 'good');
        if (run.charge >= 100) say(run, 'RESET READY', W / 2, 0.28, 'brand');
    }

    function activateReset(run) {
        if (run.charge < 100 || run.paused || run.over) return false;
        run.charge = 0;
        run.resetFor = core.RESET_SECONDS;
        say(run, '⚡ RESET MODE', W / 2, 0.4, 'brand');
        return true;
    }

    // ─────────────────────────────── mission flow ───────────────────────────────

    function completeMission(run, hud) {
        var perfect = run.missionLivesLost === 0 && run.missionMisses === 0;
        if (perfect) run.perfectMissions += 1;
        run.lastMission = {
            name: mission(run).name,
            perfect: perfect,
            seconds: run.missionTime,
            misses: run.missionMisses,
            livesLost: run.missionLivesLost
        };
        run.missionMisses = 0;
        run.missionLivesLost = 0;
        run.missionIndex += 1;
        if (run.missionIndex >= core.MISSIONS.length) {
            run.over = true;
            run.outcome = 'All five missions cleared.';
            if (hud) hud.finish();
            return;
        }
        run.progress = {};
        run.actors = [];
        run.missionTime = 0;
        run.spawnIn = 0.6;
        run.ammo = core.MAGAZINE;
        run.bossExposed = true;
        run.bossPhaseTime = 0;
        run.paused = true;
        if (hud) hud.brief();
    }

    function failMission(run, why) {
        run.over = true;
        run.outcome = why;
    }

    // ─────────────────────────────── rendering ───────────────────────────────

    function createRenderer(canvas, options) {
        var ctx = canvas.getContext('2d');
        var reduced = !!(options && options.reducedMotion);
        // Two scales, because they answer different questions. `scale` is backing-store pixels per world
        // unit, and is what drawing needs. `cssScale` is CSS pixels per world unit, and is what anything
        // measured against a finger needs: the 44px tap floor is 44 CSS px, not 44 device pixels. Using
        // the first for the second made the floor 22 CSS px on every 2x phone.
        var scale = 1;
        var cssScale = 1;

        function resize() {
            var box = canvas.getBoundingClientRect();
            if (box.width === 0) return cssScale;
            // Capped at 2: beyond that a mid-range phone spends its frame budget on pixels nobody sees.
            var dpr = Math.min(global.devicePixelRatio || 1, 2);
            var width = Math.max(1, Math.round(box.width * dpr));
            var height = Math.max(1, Math.round(box.height * dpr));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            scale = canvas.width / W;
            cssScale = box.width / W;
            // What callers get back is the scale hit testing needs; drawing reads `scale` itself.
            return cssScale;
        }

        function palette(name) {
            var styles = global.getComputedStyle(canvas);
            return styles.getPropertyValue(name).trim() || '#ffffff';
        }

        var colours = null;
        function colour(name) {
            if (!colours) {
                colours = {
                    ground: palette('--ground'),
                    surface: palette('--surface'),
                    line: palette('--line'),
                    ink: palette('--ink'),
                    faint: palette('--ink-faint'),
                    brand: palette('--brand'),
                    brandBright: palette('--brand-bright'),
                    target: palette('--state-stale'),
                    civilian: palette('--brand-bright'),
                    verified: palette('--state-verified'),
                    hostile: palette('--state-unavailable')
                };
            }
            return colours[name];
        }

        function figure(run, a) {
            var x = a.x * scale;
            var y = a.y * scale;
            var r = a.r * scale;
            var isTarget = a.kind === 'target';
            ctx.save();
            ctx.translate(x, y);

            // A target is a hard-edged hostile; a civilian is soft and open-handed. Shape carries the
            // difference as well as colour, because identification is the game and colour alone is not
            // something every player can rely on.
            ctx.lineWidth = Math.max(2, r * 0.22);
            ctx.strokeStyle = isTarget ? colour('target') : colour('civilian');
            ctx.fillStyle = ctx.strokeStyle;

            if (isTarget) {
                ctx.beginPath();
                ctx.moveTo(0, -r);
                ctx.lineTo(r * 0.8, 0);
                ctx.lineTo(0, r);
                ctx.lineTo(-r * 0.8, 0);
                ctx.closePath();
                ctx.stroke();
                ctx.globalAlpha = 0.25;
                ctx.fill();
                ctx.globalAlpha = 1;
            } else {
                ctx.beginPath();
                ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(-r * 0.4, r * 0.1);
                ctx.lineTo(r * 0.4, r * 0.1);
                ctx.stroke();
            }

            if (a.occluded) {
                ctx.globalAlpha = 0.35;
                ctx.strokeStyle = colour('faint');
                ctx.beginPath();
                ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            // The hostage, drawn on exactly the side the hit test protects.
            if (a.hostage) {
                var hx = Math.cos(a.hostage.angle) * r * 0.95;
                var hy = Math.sin(a.hostage.angle) * r * 0.95;
                ctx.fillStyle = colour('verified');
                ctx.beginPath();
                ctx.arc(hx, hy, r * 0.42, 0, Math.PI * 2);
                ctx.fill();
                // And the arc it occupies, so the rule is visible rather than learned by losing.
                ctx.strokeStyle = colour('verified');
                ctx.globalAlpha = 0.5;
                ctx.lineWidth = Math.max(2, r * 0.16);
                ctx.beginPath();
                ctx.arc(0, 0, r * 1.15, a.hostage.angle - a.hostage.arc / 2, a.hostage.angle + a.hostage.arc / 2);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            // Taking aim: a ring that closes. Visible long enough to get into cover.
            if (a.aiming > 0 && !a.hasFired) {
                var t = clamp(a.aiming / AIM_SECONDS, 0, 1);
                ctx.strokeStyle = colour('target');
                ctx.lineWidth = Math.max(2, r * 0.14);
                ctx.globalAlpha = reduced ? 0.8 : 0.5 + 0.5 * t;
                ctx.beginPath();
                ctx.arc(0, 0, r * (2.2 - t), 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            ctx.restore();
        }

        function draw(run) {
            var px = scale;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Ground and a skyline, so the board has a floor and a sense of depth.
            ctx.fillStyle = colour('ground');
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = colour('surface');
            for (var i = 0; i < 9; i++) {
                var bw = W / 9;
                var bh = (0.16 + ((i * 37) % 5) * 0.045) * px;
                ctx.fillRect(i * bw * px, canvas.height - bh, bw * px * 0.86, bh);
            }
            ctx.strokeStyle = colour('line');
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, H * px - 0.001);
            ctx.lineTo(canvas.width, H * px - 0.001);
            ctx.stroke();

            // Feedback is drawn BEFORE the contacts, not after. The brief is explicit that effects must
            // not obscure targets, and the only way to guarantee that rather than hope for it is for the
            // contacts to be painted on top: where floating score and a contact collide, the thing being
            // identified wins. The text is offset above its contact so in practice both are readable.
            drawEffects(run, px);

            for (var a = 0; a < run.actors.length; a++) {
                var actor = run.actors[a];
                if (actor.dead || actor.hidden) continue;
                // Scoped: the board outside the scope is not yours to see. This is the cost.
                if (run.scoped) {
                    var d = Math.sqrt(Math.pow(actor.x - run.aim.x, 2) + Math.pow(actor.y - run.aim.y, 2));
                    if (d > SCOPE_RADIUS) continue;
                }
                figure(run, actor);
            }

            if (run.scoped) drawScope(run, px);
            if (run.inCover) drawCover(px);
            drawCrosshair(run, px);
        }

        function drawScope(run, px) {
            var cx = run.aim.x * px;
            var cy = run.aim.y * px;
            var r = SCOPE_RADIUS * px;
            ctx.save();
            // Everything outside the circle is dimmed, not hidden behind a solid wall: the player should
            // know the board is still there, and that they cannot see into it.
            ctx.fillStyle = colour('ground');
            ctx.globalAlpha = 0.82;
            ctx.beginPath();
            ctx.rect(0, 0, canvas.width, canvas.height);
            ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
            ctx.fill('evenodd');
            ctx.globalAlpha = 1;
            ctx.strokeStyle = colour('brandBright');
            ctx.lineWidth = Math.max(2, px * 0.006);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        function drawCover(px) {
            ctx.save();
            // A vignette and a parapet, not a blackout. The prototype painted the whole scene out while
            // the clock kept running, so cover meant playing blind.
            ctx.fillStyle = colour('ground');
            ctx.globalAlpha = 0.35;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1;
            ctx.fillStyle = colour('surface');
            ctx.fillRect(0, canvas.height - px * 0.16, canvas.width, px * 0.16);
            ctx.strokeStyle = colour('verified');
            ctx.lineWidth = Math.max(2, px * 0.008);
            ctx.beginPath();
            ctx.moveTo(0, canvas.height - px * 0.16);
            ctx.lineTo(canvas.width, canvas.height - px * 0.16);
            ctx.stroke();
            ctx.restore();
        }

        function drawCrosshair(run, px) {
            var x = run.aim.x * px;
            var y = run.aim.y * px;
            var r = (run.scoped ? 0.022 : 0.036) * px;
            ctx.save();
            ctx.strokeStyle = run.resetFor > 0 ? colour('brandBright') : colour('ink');
            ctx.lineWidth = Math.max(1, px * 0.0035);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.moveTo(x - r * 1.8, y);
            ctx.lineTo(x - r * 0.4, y);
            ctx.moveTo(x + r * 0.4, y);
            ctx.lineTo(x + r * 1.8, y);
            ctx.moveTo(x, y - r * 1.8);
            ctx.lineTo(x, y - r * 0.4);
            ctx.moveTo(x, y + r * 0.4);
            ctx.lineTo(x, y + r * 1.8);
            ctx.stroke();
            ctx.restore();
        }

        function drawEffects(run, px) {
            ctx.save();
            ctx.textAlign = 'center';
            for (var i = 0; i < run.effects.length; i++) {
                var e = run.effects[i];
                ctx.globalAlpha = reduced ? 1 : clamp(e.life / 0.9, 0, 1);
                ctx.fillStyle = e.tone === 'bad' ? colour('target')
                    : e.tone === 'brand' ? colour('brandBright')
                        : e.tone === 'note' ? colour('faint') : colour('verified');
                ctx.font = '700 ' + Math.max(11, px * 0.045) + 'px ' + 'system-ui, sans-serif';
                // Floating text sits above the contact so it never covers the thing being identified.
                var rise = reduced ? 0 : (0.9 - e.life) * 0.05;
                ctx.fillText(e.text, e.x * px, (e.y - 0.07 - rise) * px);
            }
            ctx.globalAlpha = 1;
            for (var s = 0; s < run.shots.length; s++) {
                var shot = run.shots[s];
                ctx.strokeStyle = colour('target');
                ctx.globalAlpha = clamp(shot.life / 0.45, 0, 1);
                ctx.lineWidth = Math.max(2, px * 0.006);
                ctx.beginPath();
                ctx.arc(shot.x * px, shot.y * px, px * 0.05 * (1 - shot.life / 0.45 + 0.3), 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        return {
            resize: resize,
            draw: draw,
            scaleOf: function () { return scale; },
            cssScaleOf: function () { return cssScale; }
        };
    }

    global.ResetScope = {
        createRun: createRun,
        createRenderer: createRenderer,
        update: update,
        fire: fire,
        activateReset: activateReset,
        mission: mission,
        SCOPE_RADIUS: SCOPE_RADIUS,
        AIM_SECONDS: AIM_SECONDS
    };
})(typeof window !== 'undefined' ? window : this);
