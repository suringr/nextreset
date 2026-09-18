/**
 * V4, PR 7: the rules of RESET//SCOPE, tested without a browser.
 *
 * The discovery report found three mechanics that did not do what they claimed, and they are the reason
 * most of this file exists:
 *
 *   Scope was a strictly dominant buff — it widened the hit area and cost nothing, so the optimal play
 *   was to hold it permanently and the "tradeoff" was a word in a design document.
 *   Cover was compulsory rather than tactical, because ammunition regenerated only inside it.
 *   The hostage was drawn on one side and the penalty was tested radially, so a shot on the empty side
 *   killed the hostage. A player cannot learn a rule the code does not implement.
 *
 * Every random decision goes through a seeded generator, so these are assertions about rules rather
 * than observations about a particular run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { ACHIEVEMENTS, XP_AWARDS } from "../../design/progression";
import { staticPageDecision } from "../../indexing";
import { gamePages } from "../../update-game-pages";
import { PLAY_PATH, PLAY_URL } from "../../update-play-page";

const ROOT = path.join(__dirname, "..", "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "public", "assets", "scope-core.js"), "utf8");

interface Actor {
    x: number;
    y: number;
    r: number;
    kind: string;
    hostage?: { angle: number; arc: number } | null;
    hidden?: boolean;
    dead?: boolean;
    born?: number;
}

interface Core {
    WORLD: { w: number; h: number };
    MIN_TAP_PX: number;
    COMBO_CAP: number;
    RESET_SCORE_MULTIPLIER: number;
    RESET_SECONDS: number;
    RESET_TIME_SCALE: number;
    MAGAZINE: number;
    RELOAD_IN_COVER: number;
    RELOAD_EXPOSED: number;
    LIVES: number;
    MULTIKILL_WINDOW: number;
    MULTIKILL_BONUS: number;
    RANK_THRESHOLDS: Array<{ rank: string; score: number }>;
    MISSIONS: Array<Record<string, never> & {
        id: string; name: string; brief: string; objective: Record<string, number>; seconds: number;
        expose: number[]; spawnEvery: number[]; concurrent: number; size: number[]; targetChance: number;
        hostages: boolean; incomingFire: boolean; lanes: number;
    }>;
    createRng(seed: number): { next(): number; between(a: number, b: number): number; chance(p: number): boolean; pick<T>(items: T[]): T };
    hitRadius(actor: Actor, options?: Record<string, unknown>): number;
    distanceTo(actor: Actor, x: number, y: number): number;
    hitsHostage(actor: Actor, x: number, y: number): boolean;
    resolveShot(actors: Actor[], x: number, y: number, options?: Record<string, unknown>): { kind: string; actor?: Actor; precision?: number; bullseye?: boolean; distance?: number };
    scoreForHit(hit: Record<string, unknown>, context?: Record<string, unknown>): { points: number; events: string[] };
    chargeForHit(hit: Record<string, unknown>, context?: Record<string, unknown>): number;
    rankFor(score: number): string;
    reload(ammo: number, inCover: boolean, dt: number): number;
    canFire(state: Record<string, unknown>): boolean;
    objectiveMet(mission: unknown, progress: Record<string, number>): boolean;
    objectiveText(mission: unknown, progress: Record<string, number>): string;
    missionProgress(mission: unknown, progress: Record<string, number>): number;
    exposureFor(mission: unknown, progress: Record<string, number>): number;
}

function load(): Core {
    const window: Record<string, unknown> = {};
    // eslint-disable-next-line no-new-func
    new Function("window", SOURCE)(window);
    return window.ResetScopeCore as Core;
}

const core = load();

function actor(over: Partial<Actor> = {}): Actor {
    return { x: 0.5, y: 0.5, r: 0.06, kind: "target", hostage: null, born: 1, ...over };
}

test("the same seed is the same run", () => {
    // What makes the rules testable at all, and what would let a Daily Contract give everyone the same
    // run from a date seed with no server involved.
    const a = core.createRng(1234);
    const b = core.createRng(1234);
    const c = core.createRng(1235);
    const first = [a.next(), a.next(), a.next(), a.next()];
    const same = [b.next(), b.next(), b.next(), b.next()];
    const other = [c.next(), c.next(), c.next(), c.next()];
    assert.deepEqual(first, same);
    assert.notDeepEqual(first, other);
    for (const n of first) assert.ok(n >= 0 && n < 1, `${n} is not in [0,1)`);
});

test("no target is ever smaller than a finger, however small it is drawn", () => {
    // WCAG 2.5.5 asks 44px; the floor is half of that as a radius. Sniper contacts draw at about
    // a fortieth of the board, which on a 390px screen is roughly 9px across.
    const tiny = actor({ r: 0.011 });
    const onAPhone = 390; // pixels per world unit at 390px wide
    const reach = core.hitRadius(tiny, { pixelsPerUnit: onAPhone });
    assert.equal(Math.round(reach * onAPhone * 2), core.MIN_TAP_PX, "the hit area is a full 44px across");
    assert.ok(reach > tiny.r, "which is larger than the drawing");

    // A large contact is not shrunk to the floor.
    const big = actor({ r: 0.2 });
    assert.equal(core.hitRadius(big, { pixelsPerUnit: onAPhone }), 0.2);
});

test("scope buys precision with awareness, and the cost is enforced here", () => {
    // The whole tradeoff. Scoped, the hit area grows — and anything outside the scope circle is not a
    // candidate at all, so the edges of the board are genuinely gone rather than merely dimmed.
    const near = actor({ x: 0.5, y: 0.5 });
    const far = actor({ x: 0.95, y: 1.1 });
    const scope = { x: 0.5, y: 0.5, r: 0.3 };

    const unscoped = core.hitRadius(near, {});
    const scoped = core.hitRadius(near, { scoped: true });
    assert.ok(scoped > unscoped, "scoped shots reach further into the target");

    // A contact outside the scope cannot be hit while scoped, and can be hit when not.
    assert.equal(core.resolveShot([far], far.x, far.y, { scoped: true, scope }).kind, "miss");
    assert.equal(core.resolveShot([far], far.x, far.y, {}).kind, "target");
});

test("the hostage is protected on the side it is drawn on", () => {
    // The prototype's bug, exactly: hostage drawn to the right, penalty tested as radial distance, so a
    // shot on the left edge killed the hostage.
    const held = actor({ r: 0.1, hostage: { angle: 0, arc: Math.PI * 0.9 } });

    // Right of centre — where the hostage is — is a hostage hit.
    assert.equal(core.hitsHostage(held, held.x + 0.08, held.y), true);
    // Left of centre, the same distance away, is not.
    assert.equal(core.hitsHostage(held, held.x - 0.08, held.y), false);

    // And through the shot resolver, which is what the game actually calls.
    assert.equal(core.resolveShot([held], held.x + 0.08, held.y, {}).kind, "hostage");
    assert.equal(core.resolveShot([held], held.x - 0.08, held.y, {}).kind, "target");

    // The same holds whichever side the hostage is on.
    const above = actor({ r: 0.1, hostage: { angle: -Math.PI / 2, arc: Math.PI * 0.9 } });
    assert.equal(core.resolveShot([above], above.x, above.y - 0.08, {}).kind, "hostage");
    assert.equal(core.resolveShot([above], above.x, above.y + 0.08, {}).kind, "target");
});

test("a civilian is never a target, and a miss is a miss", () => {
    const civ = actor({ kind: "civilian" });
    assert.equal(core.resolveShot([civ], civ.x, civ.y, {}).kind, "civilian");
    assert.equal(core.resolveShot([actor()], 0.05, 0.05, {}).kind, "miss");
    assert.equal(core.resolveShot([], 0.5, 0.5, {}).kind, "miss");
    assert.equal(core.resolveShot([actor({ hidden: true })], 0.5, 0.5, {}).kind, "miss", "a hidden contact is not there");
    assert.equal(core.resolveShot([actor({ dead: true })], 0.5, 0.5, {}).kind, "miss");
});

test("a shot resolves against the nearest candidate, not the first one found", () => {
    const far = actor({ x: 0.56 });
    const near = actor({ x: 0.5 });
    const hit = core.resolveShot([far, near], 0.5, 0.5, {});
    assert.equal(hit.actor, near);
});

test("precision is measured from the centre, and a bullseye is the middle of the target", () => {
    const a = actor({ r: 0.1 });
    const centre = core.resolveShot([a], a.x, a.y, {});
    assert.equal(centre.precision, 1);
    assert.equal(centre.bullseye, true);

    const edge = core.resolveShot([a], a.x + 0.095, a.y, {});
    assert.ok((edge.precision ?? 1) < 0.2, `edge precision was ${edge.precision}`);
    assert.equal(edge.bullseye, false);
});

test("cover is a choice about tempo, not a requirement", () => {
    // The prototype regenerated ammunition only in cover, which made cover compulsory. A magazine
    // refills outside it too — just slowly enough that cover is worth taking.
    assert.ok(core.RELOAD_EXPOSED > 0, "you are never stranded with an empty magazine");
    assert.ok(core.RELOAD_IN_COVER > core.RELOAD_EXPOSED * 3, "and cover is meaningfully faster");

    assert.equal(core.reload(0, true, 1), core.RELOAD_IN_COVER);
    assert.equal(core.reload(0, false, 1), core.RELOAD_EXPOSED);
    assert.equal(core.reload(core.MAGAZINE, true, 5), core.MAGAZINE, "and never overfills");
});

test("you cannot fire from cover, or when paused, over, or empty", () => {
    const ready = { inCover: false, paused: false, over: false, ammo: 3 };
    assert.equal(core.canFire(ready), true);
    assert.equal(core.canFire({ ...ready, inCover: true }), false, "cover protects, and the price is not firing");
    assert.equal(core.canFire({ ...ready, paused: true }), false);
    assert.equal(core.canFire({ ...ready, over: true }), false);
    assert.equal(core.canFire({ ...ready, ammo: 0.5 }), false, "a partial round is not a round");
});

test("the combo caps, and RESET mode is worth using for time rather than points", () => {
    // Uncapped combo times a doubling multiplier meant one late hit outscored a whole early mission.
    assert.equal(core.COMBO_CAP, 8);
    assert.ok(core.RESET_SCORE_MULTIPLIER <= 1.5, "RESET must not be a scoring exploit");

    const hit = { kind: "target", precision: 1, bullseye: true, actor: actor() };
    const atCap = core.scoreForHit(hit, { combo: 8 }).points;
    const beyond = core.scoreForHit(hit, { combo: 40 }).points;
    assert.equal(beyond, atCap, "a combo past the cap is worth no more");

    const plain = core.scoreForHit(hit, { combo: 1 }).points;
    const inReset = core.scoreForHit(hit, { combo: 1, resetMode: true }).points;
    assert.equal(inReset, Math.round(plain * core.RESET_SCORE_MULTIPLIER));

    // The thing RESET actually buys: time, and a wider window.
    assert.ok(core.RESET_TIME_SCALE < 0.6, "time slows noticeably");
    assert.ok(core.hitRadius(actor(), { resetMode: true }) > core.hitRadius(actor(), {}));
});

test("the worst-case single hit cannot outscore a mission", () => {
    // What the tuning is for. A bullseye quickshot hostage save at the cap, in RESET mode.
    const best = core.scoreForHit(
        { kind: "target", precision: 1, bullseye: true, actor: actor({ hostage: { angle: 0, arc: 1 } }) },
        { combo: core.COMBO_CAP, resetMode: true, exposedFor: 0.2 }
    ).points;
    // A plain confirmed target at the start of a run.
    const ordinary = core.scoreForHit({ kind: "target", precision: 0.3, bullseye: false, actor: actor() }, { combo: 1 }).points;
    assert.ok(best / ordinary < 60, `one hit is worth ${Math.round(best / ordinary)}× an ordinary one`);
    assert.ok(best < core.RANK_THRESHOLDS[0].score / 3, "and no single hit is a third of an S rank");
});

test("named events are reported so the game can say what just happened", () => {
    const quick = core.scoreForHit({ kind: "target", precision: 0.5, bullseye: false, actor: actor() }, { exposedFor: 0.3 });
    assert.deepEqual(quick.events, ["QUICKSHOT"]);
    const bull = core.scoreForHit({ kind: "target", precision: 1, bullseye: true, actor: actor() }, { exposedFor: 3 });
    assert.deepEqual(bull.events, ["BULLSEYE"]);
    const save = core.scoreForHit({ kind: "target", precision: 0.5, bullseye: false, actor: actor({ hostage: { angle: 0, arc: 1 } }) }, { exposedFor: 3 });
    assert.deepEqual(save.events, ["HOSTAGE SAVE"]);
    assert.deepEqual(core.scoreForHit({ kind: "target", precision: 0.4, actor: actor() }, { exposedFor: 3 }).events, []);
});

test("the meter is charged by skill and by nothing else", () => {
    const plain = core.chargeForHit({ kind: "target" }, { exposedFor: 3 });
    const bull = core.chargeForHit({ kind: "target", bullseye: true }, { exposedFor: 3 });
    const quick = core.chargeForHit({ kind: "target" }, { exposedFor: 0.2 });
    const save = core.chargeForHit({ kind: "target", actor: actor({ hostage: { angle: 0, arc: 1 } }) }, { exposedFor: 3 });
    assert.ok(bull > plain && quick > plain && save > plain);
    // And it takes several hits to fill, so RESET is spent rather than held permanently.
    assert.ok(100 / bull >= 4, `${Math.ceil(100 / bull)} bullseyes should not be fewer than four`);
});

test("rank is a stated threshold, so the end screen can explain itself", () => {
    assert.equal(core.rankFor(0), "D");
    assert.equal(core.rankFor(3999), "D");
    assert.equal(core.rankFor(4000), "C");
    assert.equal(core.rankFor(9000), "B");
    assert.equal(core.rankFor(16000), "A");
    assert.equal(core.rankFor(26000), "S");
    assert.equal(core.rankFor(10_000_000), "S");
    // Descending, so the first threshold a score clears is its rank.
    for (let i = 1; i < core.RANK_THRESHOLDS.length; i++) {
        assert.ok(core.RANK_THRESHOLDS[i].score < core.RANK_THRESHOLDS[i - 1].score);
    }
});

test("there are five missions and each has its own rules, not its own label", () => {
    assert.equal(core.MISSIONS.length, 5);
    assert.deepEqual(core.MISSIONS.map(m => m.id), ["quick-draw", "hostage", "sniper", "crossfire", "boss"]);

    const byId = (id: string) => core.MISSIONS.find(m => m.id === id)!;

    // Quick Draw and Crossfire differed only in target ratio in the prototype: both moved, both spawned
    // single contacts. They are now different problems.
    const quick = byId("quick-draw");
    const crossfire = byId("crossfire");
    assert.equal(quick.lanes, 0);
    assert.ok(crossfire.lanes >= 3, "Crossfire moves in lanes");
    assert.ok(crossfire.concurrent > quick.concurrent, "and several at once");
    assert.equal(crossfire.incomingFire, true, "and shoots back");
    assert.equal(quick.incomingFire, false);

    // Sniper is about identification, and its contacts are drawn small.
    assert.ok(byId("sniper").size[1] < quick.size[0]);
    // Hostage is the only mission that spawns hostages.
    assert.deepEqual(core.MISSIONS.filter(m => m.hostages).map(m => m.id), ["hostage"]);
    // Incoming fire exists only where it adds something.
    assert.deepEqual(core.MISSIONS.filter(m => m.incomingFire).map(m => m.id), ["crossfire", "boss"]);

    for (const m of core.MISSIONS) {
        assert.ok(m.brief.length > 20, `${m.id} does not explain itself`);
        assert.ok(m.seconds > 0, `${m.id} has no clock`);
        assert.ok(Object.keys(m.objective).length === 1, `${m.id} should ask for exactly one thing`);
        assert.ok(m.expose[1] < m.expose[0], `${m.id}: exposure should narrow, not widen`);
    }
});

test("a mission is finished by its objective, never by waiting out the clock", () => {
    // The prototype advanced every mission after twenty seconds whatever the player did, so a player
    // who never fired reached the boss.
    const quick = core.MISSIONS[0];
    assert.equal(core.objectiveMet(quick, {}), false);
    assert.equal(core.objectiveMet(quick, { confirms: 7 }), false);
    assert.equal(core.objectiveMet(quick, { confirms: 8 }), true);
    assert.equal(core.objectiveMet(quick, { confirms: 99 }), true);

    const hostage = core.MISSIONS[1];
    assert.equal(core.objectiveMet(hostage, { confirms: 99 }), false, "confirms are not saves");
    assert.equal(core.objectiveMet(hostage, { saves: 5 }), true);

    const boss = core.MISSIONS[4];
    assert.equal(core.objectiveMet(boss, { phases: 2 }), false);
    assert.equal(core.objectiveMet(boss, { phases: 3 }), true);
});

test("the objective reads as a sentence the HUD can show", () => {
    assert.equal(core.objectiveText(core.MISSIONS[0], { confirms: 3 }), "3 / 8 confirmed");
    assert.equal(core.objectiveText(core.MISSIONS[1], {}), "0 / 5 saved");
    assert.equal(core.objectiveText(core.MISSIONS[4], { phases: 1 }), "Phase 2 / 3");
    assert.equal(core.objectiveText(core.MISSIONS[4], { phases: 3 }), "Phase 3 / 3", "and never reads past the end");
});

test("difficulty comes from the exposure window, driven by progress rather than by the clock", () => {
    const quick = core.MISSIONS[0];
    const atStart = core.exposureFor(quick, {});
    const halfway = core.exposureFor(quick, { confirms: 4 });
    const atEnd = core.exposureFor(quick, { confirms: 8 });
    assert.equal(atStart, quick.expose[0]);
    assert.equal(atEnd, quick.expose[1]);
    assert.ok(halfway < atStart && halfway > atEnd, "it narrows steadily");
    // A player past the objective is not punished twice.
    assert.equal(core.exposureFor(quick, { confirms: 50 }), quick.expose[1]);
    assert.equal(core.missionProgress(quick, { confirms: 50 }), 1);
});

test("a multikill is a flat bonus, not another multiplier", () => {
    assert.ok(core.MULTIKILL_BONUS > 0);
    assert.ok(core.MULTIKILL_WINDOW > 0 && core.MULTIKILL_WINDOW < 3);
    // Flat, so it cannot compound with the combo into the same runaway the prototype had.
    const hit = { kind: "target", precision: 1, bullseye: true, actor: actor() };
    assert.ok(core.MULTIKILL_BONUS < core.scoreForHit(hit, { combo: core.COMBO_CAP }).points);
});

test("a run starts with lives and a full magazine", () => {
    assert.equal(core.LIVES, 3);
    assert.ok(core.MAGAZINE >= 5);
    assert.ok(core.RESET_SECONDS >= 3 && core.RESET_SECONDS <= 8, "long enough to use, short enough to want back");
});

test("the board is a portrait rectangle, not a fixed pixel size", () => {
    // The prototype worked in 960×540 pixels and mobile CSS stretched it into a square, so every circle
    // drew as an ellipse. Sizes here are ratios and the renderer scales them.
    assert.equal(core.WORLD.w, 1);
    assert.ok(core.WORLD.h > core.WORLD.w, "portrait");
    assert.equal(core.WORLD.h / core.WORLD.w, 1.25, "4:5");
});

// === V4 PR 7: the arcade route ===

test("the arcade is reachable from the homepage, and carries none of the game's code", () => {
    const home = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    assert.ok(home.includes(`href="/play/"`), "the homepage links to the arcade");
    // The entry card is markup and three numbers. The engine stays on its own page.
    for (const asset of ["scope-core.js", "scope.js", "scope-play.js"]) {
        assert.ok(!home.includes(asset), `the homepage loads ${asset}`);
    }
    for (const page of gamePages) {
        const tracker = fs.readFileSync(path.join(ROOT, "public", page.path), "utf8");
        for (const asset of ["scope-core.js", "scope.js", "scope-play.js"]) {
            assert.ok(!tracker.includes(asset), `${page.path} loads ${asset}`);
        }
    }
});

test("the arcade page is the only page that loads the game", () => {
    const play = fs.readFileSync(path.join(ROOT, "public", PLAY_PATH), "utf8");
    for (const asset of ["player.js", "scope-core.js", "scope.js", "scope-play.js"]) {
        assert.ok(play.includes(`/assets/${asset}`), `/play/ does not load ${asset}`);
    }
});

test("the arcade page carries everything a page on this site carries", () => {
    const play = fs.readFileSync(path.join(ROOT, "public", PLAY_PATH), "utf8");
    assert.ok(play.includes(`<link rel="canonical" href="${PLAY_URL}">`), "canonical");
    assert.equal((play.match(/<h1/g) ?? []).length, 1, "exactly one h1");
    assert.ok(play.includes(`class="breadcrumbs"`), "breadcrumb");
    assert.equal((play.match(/"@type": "BreadcrumbList"/g) ?? []).length, 1, "breadcrumb schema");
    assert.ok(play.includes(`class="footer-nav"`), "footer navigation");
    assert.ok(play.includes("G-YY6V5SR1DN"), "analytics");
    assert.ok(play.includes("<noscript>"), "and it says what to do without JavaScript");
    // Every tracker, exactly as every other page lists them.
    for (const page of gamePages) {
        assert.ok(play.includes(`href="/${page.game}/${page.type}/"`), `/play/ does not link ${page.game}`);
    }
});

test("the arcade asks not to be indexed, and is therefore not submitted", () => {
    // Evaluated at PR 7 with the page as it actually is: a canvas, plus roughly nine hundred words of
    // instructions that are genuinely specific to this game. The conclusion is still noindex — nobody
    // searches for it, indexing it gains nothing measurable, and the site was rejected once for thin
    // content, so a page whose main element is a canvas is not the one to argue about. `follow` keeps it
    // crawled and keeps its twelve tracker links working.
    const play = fs.readFileSync(path.join(ROOT, "public", PLAY_PATH), "utf8");
    assert.ok(play.includes(`<meta name="robots" content="noindex, follow">`));
    assert.equal(staticPageDecision(play).state, "noindex");
});

test("the arcade page's prose is about this game, not filler", () => {
    // The brief asked for useful original content and explicitly not for SEO padding. Each of these
    // sections exists because a player needs it, and each states something specific and checkable.
    const play = fs.readFileSync(path.join(ROOT, "public", PLAY_PATH), "utf8");
    for (const section of ["How to play", "Scope and cover are trades", "RESET MODE", "The five missions", "Scoring", "Accessibility"]) {
        assert.ok(play.includes(section), `missing section: ${section}`);
    }
    // The real numbers, so the page cannot drift from the rules.
    assert.ok(play.includes("26,000"), "the rank thresholds are stated");
    assert.ok(play.includes("44&nbsp;CSS pixels") || play.includes("44 CSS pixels"), "the tap floor is stated");
    assert.ok(play.includes("1.5"), "the RESET multiplier is stated");
    assert.ok(play.includes("&times;8") || play.includes("×8"), "the combo cap is stated");
    // And it does not claim a leaderboard, a ranking or a player count it does not have. Asserted as
    // claims rather than as substrings: the page's own honest sentence says there is no global ranking
    // to show, which a naive search for "global rank" flags as the very thing it is denying.
    assert.ok(/no account, no server and no leaderboard/i.test(play), "it says plainly what it does not have");
    assert.ok(/not going to invent one/i.test(play), "and that it will not invent one");
    assert.ok(!/\b\d[\d,]*\s+(players|people|users)\b/i.test(play), "no fabricated player count");
    assert.ok(!/(compete|compare)\s+(with|against)\s+(other\s+)?(players|everyone)/i.test(play), "no competition it cannot host");
    assert.ok(!/\btop\s+\d+\b/i.test(play), "no ranking table");
});

test("the five missions the page describes are the five the game runs", () => {
    const core = fs.readFileSync(path.join(ROOT, "public", "assets", "scope-core.js"), "utf8");
    const play = fs.readFileSync(path.join(ROOT, "public", PLAY_PATH), "utf8");
    for (const name of ["Quick Draw", "Hostage", "Sniper", "Crossfire", "Boss"]) {
        assert.ok(play.includes(name), `the page does not describe ${name}`);
        assert.ok(core.toLowerCase().includes(name.toLowerCase().replace(" ", "-")) || core.includes(name.toUpperCase()),
            `the game does not have ${name}`);
    }
    // The objectives the page states are the objectives the rules encode.
    for (const [mission, count] of [["8 targets", "confirms: 8"], ["5 hostages", "saves: 5"], ["6 targets", "confirms: 6"], ["10 targets", "confirms: 10"], ["3 phases", "phases: 3"]]) {
        assert.ok(play.includes(mission), `the page does not state "${mission}"`);
        assert.ok(core.includes(count), `the rules do not encode "${count}"`);
    }
});

// === V4 PR 8: progression ===

test("the XP table the page prints is the one the game awards", () => {
    // scope-core.js is the runtime copy and cannot be imported by the build, so the two are held
    // together here. A page that advertises a different number from the one it grants is a lie.
    const runtime = (core as unknown as { XP_AWARDS: Array<{ id: string; xp: number; why: string; repeats?: boolean }> }).XP_AWARDS;
    assert.deepEqual(
        runtime.map(a => ({ id: a.id, xp: a.xp, why: a.why, repeats: !!a.repeats })),
        XP_AWARDS.map(a => ({ id: a.id, xp: a.xp, why: a.why, repeats: !!a.repeats }))
    );
});

test("the achievement list the page prints is the one the game grants", () => {
    const runtime = (core as unknown as { ACHIEVEMENTS: Array<{ id: string; title: string; how: string }> }).ACHIEVEMENTS;
    assert.deepEqual(runtime.map(a => ({ id: a.id, title: a.title, how: a.how })),
        ACHIEVEMENTS.map(a => ({ id: a.id, title: a.title, how: a.how })));
    // And the page really does print every one, with what it asks for.
    const play = fs.readFileSync(path.join(ROOT, "public", PLAY_PATH), "utf8");
    for (const a of ACHIEVEMENTS) {
        assert.ok(play.includes(`data-achievement="${a.id}"`), `${a.id} is not on the page`);
        assert.ok(play.includes(a.title), `${a.title} is not named`);
    }
    // Locked by default, so the page reads correctly before any run and with no record behind it.
    assert.equal((play.match(/>Locked</g) ?? []).length, ACHIEVEMENTS.length);
});

test("XP is only ever for something that was done", () => {
    const runtime = (core as unknown as {
        XP_AWARDS: Array<{ id: string; why: string }>;
        xpForRun(s: Record<string, unknown>): { items: Array<{ id: string; xp: number; times: number }>; total: number };
    });
    // Nothing in the table is earned by arriving, reloading, or returning. The brief is explicit that
    // this must not become a fake engagement system, and a short auditable list is how that stays true.
    for (const award of runtime.XP_AWARDS) {
        assert.ok(!/visit|open|return|daily|login|log in|refresh/i.test(award.why),
            `"${award.why}" reads like XP for showing up`);
    }
    // A run that did nothing still earns the finishing award and nothing else.
    const nothing = runtime.xpForRun({ missionsCleared: 0, perfectMissions: 0, newHighScore: false });
    assert.deepEqual(nothing.items.map(i => i.id), ["completed-run"]);
    assert.equal(nothing.total, 40);
});

test("the XP a run earns is itemised, and adds up", () => {
    const runtime = (core as unknown as { xpForRun(s: Record<string, unknown>): { items: Array<{ id: string; xp: number; times: number }>; total: number } });
    const awarded = runtime.xpForRun({ missionsCleared: 5, perfectMissions: 2, newHighScore: true });
    assert.deepEqual(awarded.items.map(i => i.id), ["completed-run", "mission-cleared", "perfect-mission", "new-high-score"]);
    assert.equal(awarded.items.find(i => i.id === "mission-cleared")!.times, 5);
    assert.equal(awarded.total, awarded.items.reduce((sum, i) => sum + i.xp, 0));
    assert.equal(awarded.total, 40 + 125 + 70 + 50);
    // A negative or nonsense count cannot mint XP.
    assert.equal(runtime.xpForRun({ missionsCleared: -5, perfectMissions: -1 }).total, 40);
});

test("an achievement is earned by play and by nothing else", () => {
    const runtime = (core as unknown as { achievementsFor(s: Record<string, unknown>): string[] });
    // A run that finished and did nothing notable earns exactly one.
    assert.deepEqual(runtime.achievementsFor({ missionsCleared: 0, bestCombo: 1, fired: 2, hits: 0, perfectMissions: 0, hurtInnocents: true }), ["first-run"]);
    // Clean hands needs a mission cleared as well as nobody hurt, so idling cannot earn it.
    assert.ok(!runtime.achievementsFor({ missionsCleared: 0, hurtInnocents: false, fired: 0, hits: 0, bestCombo: 1 }).includes("clean-hands"));
    assert.ok(runtime.achievementsFor({ missionsCleared: 1, hurtInnocents: false, fired: 0, hits: 0, bestCombo: 1 }).includes("clean-hands"));
    // Sharpshooter needs volume as well as accuracy, so one lucky shot is not a run.
    assert.ok(!runtime.achievementsFor({ missionsCleared: 1, fired: 1, hits: 1, bestCombo: 1 }).includes("sharpshooter"));
    assert.ok(runtime.achievementsFor({ missionsCleared: 1, fired: 15, hits: 12, bestCombo: 1 }).includes("sharpshooter"));
});

test("combo milestones are a few moments, not every increment", () => {
    const runtime = (core as unknown as { COMBO_MILESTONES: number[]; COMBO_CAP: number });
    assert.ok(runtime.COMBO_MILESTONES.length <= 4, "a shout on every hit is noise on a board you are reading");
    assert.ok(runtime.COMBO_MILESTONES.includes(runtime.COMBO_CAP), "and the cap is worth marking");
    for (const m of runtime.COMBO_MILESTONES) {
        assert.ok(m >= 2 && m <= runtime.COMBO_CAP, `${m} is not a reachable combo`);
    }
});

test("feedback is drawn under the contacts, so it cannot hide one", () => {
    // The brief is explicit. Asserted on the draw order rather than by looking at a screenshot: where
    // floating score and a contact overlap, the thing being identified has to win.
    const board = fs.readFileSync(path.join(ROOT, "public", "assets", "scope.js"), "utf8");
    const effects = board.indexOf("drawEffects(run, px);");
    const actors = board.indexOf("figure(run, actor);");
    assert.ok(effects > 0 && actors > 0);
    assert.ok(effects < actors, "effects must be painted before the contacts, not over them");
});

// === Codex review of #52 ===

/** The real board (scope.js) over the real rules, with a canvas that reports a CSS box and a DPR. */
function boardAt(cssWidth: number, devicePixelRatio: number) {
    const window: Record<string, unknown> = { devicePixelRatio };
    // eslint-disable-next-line no-new-func
    new Function("window", SOURCE)(window);
    // eslint-disable-next-line no-new-func
    new Function("window", fs.readFileSync(path.join(ROOT, "public", "assets", "scope.js"), "utf8"))(window);
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({}),
        getBoundingClientRect: () => ({ width: cssWidth, height: cssWidth * 1.25 })
    };
    const game = window.ResetScope as { createRenderer(c: unknown, o?: unknown): { resize(): number; scaleOf(): number; cssScaleOf(): number } };
    return { renderer: game.createRenderer(canvas), canvas, core: window.ResetScopeCore as Core };
}

test("the tap floor is 44 CSS pixels on a 2x phone, not 44 device pixels", () => {
    // Codex P1 on #52: the scale handed to hit testing was canvas.width / W — backing-store pixels,
    // which already include the device-pixel ratio — so the promised 44 CSS px floor was 22 CSS px on
    // every 2x phone, and the smallest Sniper contacts were far harder to hit than designed.
    for (const dpr of [1, 2, 3]) {
        const { renderer, core: c } = boardAt(356, dpr);
        const cssPerUnit = renderer.resize();
        assert.equal(cssPerUnit, 356, `at DPR ${dpr} hit testing must get CSS pixels per world unit`);
        const tiny = actor({ r: 0.001 });
        const diameterCss = c.hitRadius(tiny, { pixelsPerUnit: cssPerUnit }) * 2 * cssPerUnit;
        assert.ok(Math.abs(diameterCss - 44) < 1e-9, `at DPR ${dpr} the floor is ${diameterCss.toFixed(1)} CSS px`);
    }
});

test("drawing keeps its own scale, sharp at the device's density", () => {
    const { renderer, canvas } = boardAt(356, 2);
    renderer.resize();
    assert.equal(canvas.width, 712, "the backing store is the box times the (capped) device-pixel ratio");
    assert.equal(renderer.scaleOf(), 712, "drawing uses backing-store pixels");
    assert.equal(renderer.cssScaleOf(), 356, "hit testing uses CSS pixels");
});

test("every place the page hands a scale to hit testing hands it the CSS one", () => {
    const play = fs.readFileSync(path.join(ROOT, "public", "assets", "scope-play.js"), "utf8");
    const assignments = [...play.matchAll(/pixelsPerUnit\s*=\s*([^;]+);/g)].map(m => m[1].trim());
    assert.ok(assignments.length >= 3, "the page no longer sets pixelsPerUnit where expected");
    for (const rhs of assignments) {
        assert.ok(!/\.scaleOf\(\)/.test(rhs), `pixelsPerUnit is given the drawing scale: ${rhs}`);
    }
});

test("an on-screen control latches for a mouse as well as a finger", () => {
    // Codex P2 on #52: SCOPE was a hold for a mouse, released on pointerleave, so moving from the
    // button to a contact dropped the scope before the shot. One pointer cannot hold and click at once.
    const play = fs.readFileSync(path.join(ROOT, "public", "assets", "scope-play.js"), "utf8");
    assert.ok(!/addEventListener\('pointerleave'/.test(play), "a control still releases when the pointer leaves it");
    assert.ok(!/bindHoldOrToggle/.test(play), "the hold-on-a-mouse binding is still in use");
    assert.match(play, /bindLatch\(el\.scope/);
    assert.match(play, /bindLatch\(el\.cover/);
});

test("Clean hands says what it checks: a cleared mission, and no innocent hit", () => {
    // Codex P2 on #53: the check required a cleared mission and the printed rule did not say so, so a
    // run that cleared nothing and hit no one was told it had earned an achievement it had not.
    const achievements = (core as unknown as { ACHIEVEMENTS: Array<{ id: string; how: string; check(s: unknown): boolean }> }).ACHIEVEMENTS;
    const clean = achievements.find(a => a.id === "clean-hands")!;
    assert.match(clean.how, /mission/i, "the rule does not mention the mission it requires");
    assert.equal(clean.check({ missionsCleared: 0, hurtInnocents: false }), false);
    assert.equal(clean.check({ missionsCleared: 1, hurtInnocents: false }), true);
    assert.equal(clean.check({ missionsCleared: 3, hurtInnocents: true }), false);
});
