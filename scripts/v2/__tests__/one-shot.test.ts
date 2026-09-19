/**
 * ONE SHOT // 80 CONTRACTS at /play/.
 *
 * The owner approved a finished game and asked for it to be moved over as close to 1:1 as possible. So
 * the first half of this suite is about fidelity: the script, the stylesheet and the markup are rebuilt
 * from the approved prototype and the named list of edits in `one-shot-approved.ts`, and any other
 * difference fails. The second half plays the real script, in a small simulated browser, through the
 * places where it now meets the site: resuming at the unlocked contract, a clear landing in
 * `nextreset.player.v1`, the RELOAD fix, a hidden page and N's prompt, a resize, reduced motion, and FIRE
 * for a keyboard and assistive tech.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { ONE_SHOT_CONTRACTS, ONE_SHOT_NAME, ONE_SHOT_RANKS, ONE_SHOT_RANK_XP } from "../../design/one-shot";
import { ONE_SHOT_CSS, PLAY_ADDITIONS, criticalCss } from "../../design/tokens";
import { staticPageDecision } from "../../indexing";
import { HINT, PLAY_PATH, PLAY_URL } from "../../update-play-page";
import {
    CSS_EDITS, HINT_EDIT, SCRIPT_EDITS, applyEdits, prototypeCss, prototypeHint, prototypeScript
} from "./one-shot-approved";

const ROOT = path.join(__dirname, "..", "..", "..");
const GAME = fs.readFileSync(path.join(ROOT, "public", "assets", "one-shot.js"), "utf8").replace(/\r\n/g, "\n");
const PLAYER = fs.readFileSync(path.join(ROOT, "public", "assets", "player.js"), "utf8");
const PAGE = fs.readFileSync(path.join(ROOT, "public", PLAY_PATH), "utf8");
const KEY = "nextreset.player.v1";

const BEGIN = "// ---- the approved prototype, from here to the end marker ----\n";
const END = "\n// ---- end of the approved prototype ----\n";

// === Fidelity ===

test("the game is the approved prototype's script, with the approved edits and nothing else", () => {
    const start = GAME.indexOf(BEGIN);
    const end = GAME.indexOf(END);
    assert.ok(start > 0 && end > start, "one-shot.js has lost its markers");
    const body = GAME.slice(start + BEGIN.length, end);
    const expected = applyEdits(prototypeScript(), SCRIPT_EDITS);
    if (body !== expected) {
        let at = 0;
        while (at < body.length && body[at] === expected[at]) at++;
        assert.fail(`one-shot.js differs from the approved prototype at character ${at}:\n` +
            `  one-shot.js: ${JSON.stringify(body.slice(at, at + 80))}\n  expected:    ${JSON.stringify(expected.slice(at, at + 80))}`);
    }
});

test("outside the prototype there is only the wrapper and the adapter the edits call", () => {
    assert.ok(GAME.endsWith(END + "})();\n"), "something follows the prototype");
    const adapter = GAME.slice(0, GAME.indexOf(BEGIN));
    assert.ok(adapter.startsWith("/**"), "the file does not start with its explanation");
    assert.ok(adapter.length < 4000, `the adapter has grown to ${adapter.length} characters`);
    // The adapter reads and writes the player record and the reduced-motion preference. It draws nothing,
    // listens to nothing and changes no rule of the game.
    for (const forbidden of ["ctx.", "addEventListener", "requestAnimationFrame", "spawn(", "shoot(", "missions"]) {
        assert.ok(!adapter.includes(forbidden), `the adapter does game work: ${forbidden}`);
    }
    for (const name of ["progress", "calm"]) {
        assert.ok(SCRIPT_EDITS.some(edit => edit.to.includes(name)), `the adapter defines ${name}, which no approved edit uses`);
    }
});

test("the prototype's own storage keys are gone: every read and write goes through the player record", () => {
    assert.equal((prototypeScript().match(/localStorage/g) ?? []).length, 12, "the prototype touched localStorage 12 times");
    assert.ok(!GAME.includes("localStorage"), "one-shot.js still touches localStorage");
    for (const key of ["nrUnlocked", "nrXP", "nrStar", "nrSniperBest"]) {
        assert.ok(!GAME.includes(key), `one-shot.js still names ${key}`);
    }
});

test("every approved edit says why, and each is one of the kinds the owner approved", () => {
    for (const edit of [...SCRIPT_EDITS, ...CSS_EDITS, HINT_EDIT]) {
        assert.ok(edit.why.length > 30, `an edit without a reason: ${edit.from.slice(0, 60)}`);
    }
    // Sorted by what they touch. The gameplay changes are three kinds, each approved by name: the reload
    // fix (with the replacement); the contract held while the player cannot act — a hidden page, N's
    // prompt — and the resize (after Codex's review of #61).
    const storage = SCRIPT_EDITS.filter(edit => /localStorage/.test(edit.from));
    const reload = SCRIPT_EDITS.filter(edit => /msgUntil|RELOADING|reloading/.test(edit.from));
    const hidden = SCRIPT_EDITS.filter(edit => /resumeFrom/.test(edit.to));
    const resize = SCRIPT_EDITS.filter(edit => /r\.width|spawn\(false\)/.test(edit.from));
    const motion = SCRIPT_EDITS.filter(edit => /shake/.test(edit.from));
    const access = SCRIPT_EDITS.filter(edit => /fireBtn\.addEventListener\('pointerdown'/.test(edit.from));
    assert.equal(storage.length, 5);
    assert.equal(reload.length, 2);
    assert.equal(hidden.length, 2, "the hidden page and N's prompt");
    assert.equal(resize.length, 2);
    assert.equal(motion.length, 1);
    assert.equal(access.length, 1, "FIRE for a keyboard and assistive tech");
    assert.equal(SCRIPT_EDITS.length, storage.length + reload.length + hidden.length + resize.length + motion.length + access.length,
        "an edit that is none of the approved kinds");
});

test("the stylesheet is the prototype's, with the approved header edits, and the site's additions are named", () => {
    assert.equal(ONE_SHOT_CSS, applyEdits(prototypeCss(), CSS_EDITS));
    assert.ok(criticalCss("play").endsWith(ONE_SHOT_CSS + PLAY_ADDITIONS), "the /play/ first-paint CSS is not the game's plus the additions");
    // The game's own rules, carried over untouched.
    for (const rule of ["#app{height:100dvh;display:flex;flex-direction:column}", "canvas{display:block;flex:1;width:100%;min-height:0;touch-action:none;cursor:none}",
        "#fire{position:fixed;right:20px;bottom:22px;width:106px;height:106px;", "#hint{position:fixed;left:14px;bottom:12px;"]) {
        assert.ok(ONE_SHOT_CSS.includes(rule), `a prototype rule changed: ${rule}`);
    }
});

test("the page is the prototype's markup: the same elements, ids and words, under the shared header", () => {
    const $ = cheerio.load(PAGE);
    assert.equal($("#app > header.chrome").length, 1, "the shared header is not the bar above the game");
    assert.equal($("#app > canvas#game").length, 1, "the canvas is not in the game's column");
    const fire = $("button#fire");
    assert.equal(fire.text(), "FIRE");
    assert.equal(fire.attr("aria-label"), undefined, "FIRE's fixed label would hide RELOAD and LOAD from assistive tech");
    assert.equal($("#hint").text(), applyEdits(prototypeHint(), [HINT_EDIT]));
    assert.equal(HINT, $("#hint").text());
    assert.equal($("#best").length, 1, "the status line is missing");
    assert.equal($("#best").closest("header").length, 0, "the detailed status line is in the shared header");
    // The one addition to the canvas: a name for a reader who cannot see it.
    assert.equal($("canvas#game").attr("role"), "img");
    assert.match($("canvas#game").attr("aria-label") ?? "", /ONE SHOT/);
});

test("zoom stays allowed, which the prototype had switched off", () => {
    const viewport = cheerio.load(PAGE)('meta[name="viewport"]').attr("content") ?? "";
    assert.ok(!/user-scalable\s*=\s*no|maximum-scale/i.test(viewport), `the page blocks zoom: ${viewport}`);
    // Double-tap zoom stays off where it would get in the way of play, as in the prototype.
    assert.match(ONE_SHOT_CSS, /canvas\{[^}]*touch-action:none/);
    assert.match(ONE_SHOT_CSS, /#fire\{[^}]*touch-action:manipulation/);
});

test("the name, the eighty contracts and the ranks are the game's own", () => {
    assert.ok(fs.readFileSync(path.join(ROOT, "scripts", "v2", "__tests__", "fixtures", "one-shot", "prototype.html"), "utf8").includes(ONE_SHOT_NAME));
    assert.equal(ONE_SHOT_CONTRACTS, 80);
    assert.ok(GAME.includes("Array.from({length:80}"), "the game no longer has eighty contracts");
    const ranks = /const ranks=\[([^\]]+)\]/.exec(GAME);
    assert.ok(ranks, "the game's rank list is gone");
    assert.deepEqual(ranks![1].split(",").map(r => r.replace(/'/g, "")), [...ONE_SHOT_RANKS]);
    assert.ok(GAME.includes(`Math.floor(xp/${ONE_SHOT_RANK_XP})`), "the game's rank step changed");
    assert.ok(PLAYER.includes(`var RANK_XP = ${ONE_SHOT_RANK_XP};`), "player.js ranks on a different step");
});

// === The page ===

test("/play/ is noindex, carries no ad code and no site stylesheet, and loads the game after the record", () => {
    const $ = cheerio.load(PAGE);
    assert.equal($('meta[name="robots"]').attr("content"), "noindex, follow");
    assert.equal(staticPageDecision(PAGE).state, "noindex");
    assert.equal($('link[rel="canonical"]').attr("href"), PLAY_URL);
    assert.ok(!/adsbygoogle|pagead2/.test(PAGE), "the game page carries AdSense");
    assert.equal($('link[href*="styles.v2.css"]').length, 0, "styles.v2.css would override the game's layout");
    assert.ok(PAGE.includes("G-YY6V5SR1DN"), "analytics");
    const scripts = $("script[src]").map((_, el) => $(el).attr("src")).get().filter(src => src.startsWith("/assets/"));
    assert.deepEqual(scripts.map(src => src.split("?")[0]), ["/assets/player.js", "/assets/one-shot.js"]);
    assert.equal($("script[src^='/assets/']").filter((_, el) => $(el).attr("defer") === undefined).length, 0, "a game script blocks parsing");
    assert.ok(PAGE.includes("<noscript>"), "and it says what to do without JavaScript");
});

test("its one h1 is the game's name, in the header where the prototype put it", () => {
    const $ = cheerio.load(PAGE);
    assert.equal($("h1").length, 1);
    assert.equal($("header.chrome h1.chrome-title").text(), ONE_SHOT_NAME);
    assert.ok($("title").text().startsWith(ONE_SHOT_NAME));
});

test("the page claims nothing it cannot show", () => {
    assert.ok(!/leaderboard|\btop\s+\d+\b/i.test(PAGE), "a ranking the site cannot host");
    assert.ok(!/\b\d[\d,]*\s+(players|people|users)\b/i.test(PAGE), "a player count");
    assert.ok(!/RESET\/\/SCOPE/.test(PAGE), "the old game is still named");
});

// === Playing it ===

class FakeStorage {
    items = new Map<string, string>();
    getItem(key: string): string | null { return this.items.has(key) ? this.items.get(key)! : null; }
    setItem(key: string, value: string): void { this.items.set(key, value); }
    removeItem(key: string): void { this.items.delete(key); }
}

interface Person { x: number; y: number; courier: boolean; aiming: boolean }
interface Frame { people: Person[]; texts: string[]; shook: boolean }

/**
 * The real player.js and one-shot.js in one small browser: a canvas that records what is drawn, a clock
 * and timers this test advances, and the three elements the game looks up. Nothing in the game is
 * reached into; everything is read from what it draws and what it stores.
 */
function play(options: { record?: unknown; reducedMotion?: boolean; prompt?: string | null; promptMs?: number } = {}) {
    let width = 1440, height = 848;
    const storage = new FakeStorage();
    if (options.record) storage.items.set(KEY, JSON.stringify(options.record));

    let now = 1000;
    let timers: Array<{ at: number; fn: () => void }> = [];
    let frames: Array<(t: number) => void> = [];
    let drawing: Frame = { people: [], texts: [], shook: false };
    let last: Frame = drawing;
    let background = false;
    let moved: [number, number] | null = null;
    let person: Person | null = null;

    const ctx: Record<string, unknown> = {
        fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", font: "", textAlign: "",
        save() {}, restore() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
        strokeRect() {}, roundRect() {},
        createLinearGradient() { background = true; return { addColorStop() {} }; },
        translate(x: number, y: number) { if (!background) drawing.shook = true; else moved = [x, y]; },
        arc(x: number, y: number, r: number) {
            if (x === 0 && y === -58 && r === 10 && moved) {
                person = { x: moved[0], y: moved[1], courier: false, aiming: false };
                drawing.people.push(person);
                moved = null;
            } else if (x === 48 && y === -39 && person) person.aiming = true;
        },
        fillRect(x: number, y: number) { if (ctx.fillStyle === "#d63737" && x === 10 && y === -9 && person) person.courier = true; },
        fillText(text: string) { drawing.texts.push(String(text)); }
    };
    const on: Record<string, Record<string, Array<(e: unknown) => void>>> = { canvas: {}, fire: {}, window: {}, document: {} };
    const listen = (target: string) => (type: string, fn: (e: unknown) => void) => { (on[target][type] ??= []).push(fn); };
    const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width, height }), addEventListener: listen("canvas") };
    const fire = { textContent: "FIRE", addEventListener: listen("fire") };
    const best = { textContent: "" };
    const chip = { textContent: "", hidden: true };
    const elements: Record<string, unknown> = { "#game": canvas, "#fire": fire, "#best": best };

    const document = {
        hidden: false,
        querySelector: (s: string) => elements[s] ?? null,
        getElementById: (id: string) => (id === "chrome-player" ? chip : null),
        addEventListener: listen("document")
    };
    const context: Record<string, any> = {
        console, localStorage: storage, devicePixelRatio: 1, document,
        performance: { now: () => now },
        requestAnimationFrame: (fn: (t: number) => void) => { frames.push(fn); return frames.length; },
        setTimeout: (fn: () => void, ms = 0) => { timers.push({ at: now + ms, fn }); return timers.length; },
        matchMedia: () => ({ matches: !!options.reducedMotion }),
        // A native prompt blocks the page: no frames and no timers, while the clock runs on.
        prompt: () => { now += options.promptMs ?? 0; return options.prompt ?? null; },
        addEventListener: listen("window")
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(PLAYER, context, { filename: "player.js" });
    vm.runInContext(GAME, context, { filename: "one-shot.js" });

    const step = (ms: number, visible = true) => {
        const until = now + ms;
        while (now < until) {
            now = Math.min(until, now + 16);
            const due = timers.filter(timer => timer.at <= now);
            timers = timers.filter(timer => timer.at > now);
            for (const timer of due) timer.fn();
            if (!visible) continue;             // a hidden page runs its timers but draws no frames
            const queue = frames;
            frames = [];
            for (const fn of queue) {
                drawing = { people: [], texts: [], shook: false };
                background = false; moved = null; person = null;
                fn(now);
                last = drawing;
            }
        }
    };
    const text = (pattern: RegExp) => last.texts.map(t => pattern.exec(t)).find(Boolean) ?? null;
    const game = {
        step,
        get frame() { return last; },
        get fire() { return fire.textContent; },
        get best() { return best.textContent; },
        get chip() { return chip.hidden ? null : chip.textContent; },
        contract: () => Number(text(/^LEVEL (\d+) \/ 80/)![1]),
        firesIn: () => Number(text(/^HOSTILE FIRES IN ([\d.]+)s/)![1]),
        ammo: () => text(/Ammo (\d+)\/(\d+)/)!.slice(1, 3).map(Number),
        clock: () => Number(text(/^⏱ ([\d.]+)/)![1]),
        says: (words: string) => last.texts.includes(words),
        record: () => JSON.parse(storage.items.get(KEY) ?? "null"),
        /** A left click at a point on the canvas, as a mouse delivers it. */
        click: (x: number, y: number) => { for (const fn of on.canvas.pointerdown ?? []) fn({ clientX: x, clientY: y, pointerType: "mouse", button: 0 }); },
        /** A click on the body of someone in the last frame drawn — where the game's hit test centres. */
        shootAt: (target: Person) => game.click(target.x, target.y - 35),
        key: (key: string) => { for (const fn of on.window.keydown ?? []) fn({ key, code: key === " " ? "Space" : key === "Enter" ? "Enter" : `Key${key.toUpperCase()}`, preventDefault() {} }); },
        keyUp: (key: string) => { for (const fn of on.window.keyup ?? []) fn({ key, code: key === " " ? "Space" : key === "Enter" ? "Enter" : `Key${key.toUpperCase()}` }); },
        pressFire: () => { for (const fn of on.fire.pointerdown ?? []) fn({ preventDefault() {} }); },
        /** A click on FIRE — what a pointer's release, Enter, voice control or a screen reader sends. */
        clickFire: () => { for (const fn of on.fire.click ?? []) fn({ detail: 0 }); },
        /** The page is hidden for `ms` — another tab, a locked phone — and then shown again. */
        away: (ms: number) => {
            document.hidden = true;
            for (const fn of on.document.visibilitychange ?? []) fn({});
            step(ms, false);
            document.hidden = false;
            for (const fn of on.document.visibilitychange ?? []) fn({});
        },
        /** The canvas takes a new size, as a rotation or a window resize gives it. */
        resize: (w: number, h: number) => {
            width = w; height = h;
            for (const fn of on.window.resize ?? []) fn({});
        }
    };
    game.step(32);
    return game;
}

test("a first visit starts at contract 1, and a returning player where they left off", () => {
    assert.equal(play().contract(), 1);
    assert.equal(play({ record: { version: 2, arcade: { oneShot: { unlocked: 34 } } } }).contract(), 34);
});

test("a clear lands in nextreset.player.v1: the stars, the points as XP, the next contract unlocked", () => {
    const game = play();
    game.step(400);
    const courier = game.frame.people.find(p => p.courier)!;
    assert.ok(courier, "no courier was drawn in contract 1");
    game.shootAt(courier);
    game.step(16);
    assert.ok(game.says("MISSION CLEAR"), `the clear was not shown: ${game.frame.texts.join(" | ")}`);

    const record = game.record();
    const points = record.profile.xp;
    assert.ok(points > 1000, `a quick first clear is worth over 1,000 points, got ${points}`);
    assert.equal(record.arcade.oneShot.stars[0], 3, "a clear over 1,050 points is three stars");
    assert.equal(record.arcade.oneShot.unlocked, 2);
    assert.equal(record.version, 2);
    assert.equal(game.chip, `RECRUIT · ${points.toLocaleString()} XP`, "the header's chip did not follow the clear");

    game.step(1200);
    assert.equal(game.contract(), 2, "the next contract did not start");
    assert.equal(game.best, `Recruit • XP ${points} • L2/80 `, "the game's own status line, as the prototype writes it");
});

test("N offers only the contracts unlocked", () => {
    const record = { version: 2, arcade: { oneShot: { unlocked: 12 } } };
    const picked = play({ record, prompt: "5" });
    picked.key("n");
    picked.step(32);
    assert.equal(picked.contract(), 5);
    const locked = play({ record, prompt: "40" });
    locked.key("n");
    locked.step(32);
    assert.equal(locked.contract(), 12, "a locked contract was playable");
});

// --- RELOAD: the approved fix ---

const CONTRACT_12 = { version: 2, arcade: { oneShot: { unlocked: 12 } } };

test("RELOAD takes the contract's reload time, keeps the crowd and keeps the clock", () => {
    const game = play({ record: CONTRACT_12 });
    game.step(500);
    game.click(4, 4);                                   // a clean miss, into the sky
    game.step(32);
    assert.deepEqual(game.ammo(), [2, 3]);
    const crowd = game.frame.people.map(p => p.x);
    const clock = game.clock();

    game.key("r");
    game.step(32);
    assert.equal(game.fire, "LOAD", "the button does not say it is loading");
    assert.ok(game.says("RELOADING"));
    const after = game.frame.people.map(p => p.x);
    assert.equal(after.length, crowd.length);
    for (let i = 0; i < crowd.length; i++) {
        assert.ok(Math.abs(after[i] - crowd[i]) < 5, `person ${i} jumped from ${crowd[i]} to ${after[i]}: the crowd was respawned`);
    }
    assert.ok(game.clock() <= clock && game.clock() > clock - 0.2, `the clock went from ${clock} to ${game.clock()}: it was restarted`);

    game.click(4, 4);                                   // firing while loading does nothing
    game.step(32);
    assert.deepEqual(game.ammo(), [2, 3]);

    // Contract 12 reloads in 1800 - 12 x 10 = 1680 ms, the prototype's own table.
    game.step(1500);
    assert.equal(game.fire, "LOAD", "the reload finished early");
    assert.ok(!game.says("RELOADING"), "the RELOADING notice stays up for half a second, as the prototype sets it");
    game.step(250);
    assert.equal(game.fire, "FIRE");
    assert.deepEqual(game.ammo(), [3, 3]);
});

test("a contract lost during a reload still ends, and the next attempt starts", () => {
    // Contract 12 has 19 seconds. Time runs out 200 ms into a reload; the reload's own half-second
    // timer then fires. It must not clear TIME UP, or the game would sit on a lost contract forever.
    const game = play({ record: CONTRACT_12 });
    game.step(18700);
    game.click(4, 4);
    game.key("r");
    game.step(300);
    assert.ok(game.says("TIME UP"), `expected TIME UP, saw ${game.frame.texts.join(" | ")}`);
    game.step(400);
    assert.ok(game.says("TIME UP"), "the reload's timer erased TIME UP");
    game.step(1200);
    assert.equal(game.contract(), 12);
    assert.ok(game.clock() > 18, `the next attempt did not start: the clock reads ${game.clock()}`);
    assert.equal(game.fire, "FIRE");
    assert.deepEqual(game.ammo(), [3, 3]);
});

test("contracts 1 to 10 have one bullet and no reload, as before", () => {
    const game = play();
    game.step(300);
    game.key("r");
    game.step(32);
    assert.equal(game.fire, "FIRE");
    game.click(4, 4);
    game.step(16);
    assert.ok(game.says("MISSED • -150"), "a miss with the one bullet still ends the attempt");
});

// --- reduced motion ---

test("a shot shakes the screen, except for a visitor who asked for reduced motion", () => {
    const moving = play();
    moving.step(300);
    moving.click(4, 4);
    moving.step(16);
    assert.equal(moving.frame.shook, true, "the prototype's shake is gone for everyone");

    const calm = play({ reducedMotion: true });
    calm.step(300);
    calm.click(4, 4);
    calm.step(16);
    assert.equal(calm.frame.shook, false);
    assert.ok(calm.says("MISSED • -150"), "and the shot itself is unchanged");
});

// --- the end of the campaign ---

test("clearing contract 80 keeps the run's score as the best, and the campaign starts again", () => {
    const game = play({ record: { version: 2, arcade: { oneShot: { unlocked: 80 } } } });
    assert.equal(game.contract(), 80);
    let hostile: Person | undefined;
    for (let waited = 0; waited < 6000 && !hostile; waited += 16) {
        game.step(16);
        hostile = game.frame.people.find(p => p.aiming);
    }
    assert.ok(hostile, "the armed hostile never raised his gun");
    game.shootAt(hostile!);
    game.step(16);
    const record = game.record();
    const points = record.profile.xp;
    assert.ok(points > 0);
    assert.equal(record.arcade.oneShot.stars[79] > 0, true);

    game.step(1200);
    assert.equal(game.contract(), 1, "after the eightieth the prototype starts over at the first");
    assert.equal(game.record().arcade.oneShot.bestScore, points, "the run's score is the first clear's points");
    assert.equal(game.record().arcade.oneShot.unlocked, 80, "and what is unlocked stays unlocked");
});

// --- a hidden page, and a resize: approved after Codex's review of #61 ---

test("a hidden page freezes the contract: coming back resumes exactly where it stopped", () => {
    // Codex P2 on ca1a070: frames stop in a hidden tab but performance.now() does not, so coming back
    // after the contract's time was an automatic TIME UP.
    const game = play();                                // contract 1: twenty seconds
    game.step(1000);
    const clock = game.clock();
    game.away(30000);                                   // longer than the whole contract
    game.step(32);
    assert.ok(!game.says("TIME UP"), "the contract was lost while the page was hidden");
    assert.ok(Math.abs(game.clock() - clock) <= 0.15, `the clock read ${clock} before and ${game.clock()} after`);
    assert.equal(game.contract(), 1);
    // And the time that is left still runs out as it always did.
    game.step(Math.ceil(clock * 1000) + 100);
    assert.ok(game.says("TIME UP"), "the clock stopped for good");
});

test("the armed hostile's shot waits while the page is hidden", () => {
    const game = play({ record: { version: 2, arcade: { oneShot: { unlocked: 80 } } } });
    game.step(500);                                     // contract 80 fires no sooner than 3.4 s in
    const before = game.firesIn();
    game.away(10000);
    game.step(32);
    assert.ok(!game.says("YOU WERE SHOT"), "the hostile fired at a hidden page");
    assert.ok(Math.abs(game.firesIn() - before) <= 0.15, `HOSTILE FIRES IN read ${before} before and ${game.firesIn()} after`);
});

test("a reload, and a result on screen, wait for the page too", () => {
    const reload = play({ record: CONTRACT_12 });
    reload.step(500);
    reload.click(4, 4);
    reload.key("r");
    reload.step(100);
    reload.away(5000);
    reload.step(32);
    assert.equal(reload.fire, "LOAD", "the reload finished while nobody was looking");
    reload.step(1700);
    assert.equal(reload.fire, "FIRE");

    const cleared = play();
    cleared.step(300);
    cleared.shootAt(cleared.frame.people.find(p => p.courier)!);
    cleared.step(16);
    cleared.away(5000);
    cleared.step(32);
    assert.ok(cleared.says("MISSION CLEAR"), "the result was skipped while hidden");
    cleared.step(1200);
    assert.equal(cleared.contract(), 2);
});

test("a resize keeps the crowd, the magazine and the clock, carried to the new size", () => {
    // Codex P2 on ca1a070: resize() called spawn(false) — a new crowd and a full magazine on the old clock.
    const game = play({ record: CONTRACT_12 });
    game.step(500);
    game.click(4, 4);
    game.step(32);
    assert.deepEqual(game.ammo(), [2, 3]);
    const before = game.frame.people.map(p => ({ x: p.x, y: p.y, courier: p.courier }));
    const clock = game.clock();

    game.resize(1000, 590);                             // a window made smaller; wide enough for the desktop HUD
    game.step(16);
    const after = game.frame.people;
    assert.equal(after.length, before.length, "the crowd was replaced");
    before.forEach((p, i) => {
        assert.ok(Math.abs(after[i].x - p.x * 1000 / 1440) < 3, `person ${i} was not carried: ${p.x} -> ${after[i].x}`);
        assert.ok(Math.abs(after[i].y - p.y * 590 / 848) < 3, `person ${i} was not carried: ${p.y} -> ${after[i].y}`);
        assert.equal(after[i].courier, p.courier, "the courier changed");
    });
    assert.deepEqual(game.ammo(), [2, 3], "a resize refilled the magazine");
    assert.ok(game.clock() <= clock && game.clock() > clock - 0.2, `the clock went from ${clock} to ${game.clock()}`);
});

test("rotating late in a gunman contract does not fire a new hostile", () => {
    // Codex P2 on ca1a070, reproduced on the prototype: the respawned hostile's shot was timed from the
    // contract's start, so a rotation after a few seconds often meant YOU WERE SHOT in the same frame.
    const game = play({ record: { version: 2, arcade: { oneShot: { unlocked: 31 } } } });
    game.step(5000);                                    // contract 31's hostile fires no sooner than 5.6 s in
    assert.ok(!game.says("YOU WERE SHOT"));
    const before = game.firesIn();
    game.resize(390, 844);                              // turned to portrait
    game.step(32);
    assert.ok(!game.says("YOU WERE SHOT"), "the rotation fired a new hostile");
    assert.ok(Math.abs(game.firesIn() - before) <= 0.15, `the same hostile, on the same timer: ${before} -> ${game.firesIn()}`);
});

test("a resize during a reload does not cut it short", () => {
    const game = play({ record: CONTRACT_12 });
    game.step(500);
    game.click(4, 4);
    game.key("r");
    game.step(100);
    game.resize(1200, 700);
    game.step(32);
    assert.equal(game.fire, "LOAD", "the resize finished the reload");
    assert.deepEqual(game.ammo(), [2, 3]);
});

test("N's prompt holds the contract: cancelling it resumes where it stopped", () => {
    // Codex P2 on 700acb3: the prompt blocks frames while the clock runs, so cancelling it after the
    // deadline was an automatic TIME UP, with nothing the player could have done.
    const game = play({ promptMs: 30000 });
    game.step(1000);
    const clock = game.clock();
    game.key("n");                                      // thirty seconds deciding, then cancel
    game.step(32);
    assert.ok(!game.says("TIME UP"), "cancelling the prompt lost the contract");
    assert.ok(Math.abs(game.clock() - clock) <= 0.15, `the clock read ${clock} before and ${game.clock()} after`);
    assert.equal(game.contract(), 1);

    const gunman = play({ record: { version: 2, arcade: { oneShot: { unlocked: 80 } } }, promptMs: 10000 });
    gunman.step(500);
    const before = gunman.firesIn();
    gunman.key("n");
    gunman.step(32);
    assert.ok(!gunman.says("YOU WERE SHOT"), "the hostile fired while the prompt was open");
    assert.ok(Math.abs(gunman.firesIn() - before) <= 0.15, `HOSTILE FIRES IN read ${before} before and ${gunman.firesIn()} after`);
});

test("choosing a contract in the prompt still starts it fresh", () => {
    const game = play({ record: { version: 2, arcade: { oneShot: { unlocked: 12 } } }, prompt: "3", promptMs: 30000 });
    game.step(500);
    game.key("n");
    game.step(32);
    assert.equal(game.contract(), 3);
    assert.ok(game.clock() > 19.5, `contract 3 did not start on a full clock: ${game.clock()}`);
});

// --- FIRE for a keyboard and assistive tech ---

test("FIRE works from Enter, voice control, a switch or a screen reader: a click alone fires", () => {
    // Codex P2 on 48f788e: FIRE listened only for pointerdown, and these all send a plain click.
    const game = play({ record: CONTRACT_12 });         // three rounds; the default aim is empty sky
    game.step(300);
    game.clickFire();                                   // voice control or a screen reader: a click, nothing before it
    game.step(32);
    assert.deepEqual(game.ammo(), [2, 3]);
    game.key("Enter"); game.clickFire(); game.keyUp("Enter");
    game.step(32);
    assert.deepEqual(game.ammo(), [1, 3], "Enter on the focused button did not fire");
});

test("nothing fires twice: a pointer press, or Space, is not fired again by the click that follows it", () => {
    const game = play({ record: CONTRACT_12 });
    game.step(300);
    game.pressFire(); game.clickFire();                 // a tap or a mouse press, then the click it ends in
    game.step(32);
    assert.deepEqual(game.ammo(), [2, 3], "a tap fired twice");
    game.key(" "); game.clickFire(); game.keyUp(" ");   // Space on the focused button, where a browser also clicks
    game.step(32);
    assert.deepEqual(game.ammo(), [1, 3], "Space fired twice");
    game.clickFire();                                   // and after both, a click alone still fires
    game.step(32);
    assert.deepEqual(game.ammo(), [0, 3]);
});
