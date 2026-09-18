/**
 * The homepage's arcade card: it has to read as the game it opens.
 *
 * V4's correction round found a card that said nothing about being playable, and gave it a picture of
 * the board. The game is now ONE SHOT // 80 CONTRACTS, so the picture is ONE SHOT's street: its skyline,
 * its crowd, the courier's red case, the armed hostile's raised gun and the scope. The tests that matter
 * keep it *that* game — a picture that drifts from what it depicts teaches a player the wrong thing
 * before the first contract.
 *
 * Its colours are written as literals, unlike the rest of the site, and deliberately: they are the game's
 * colours, not the site's palette, and the rule this suite enforces is that each one is a colour
 * `one-shot.js` actually draws with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { ONE_SHOT_NAME } from "../../design/one-shot";

const ROOT = path.join(__dirname, "..", "..", "..");
const homepage = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const game = fs.readFileSync(path.join(ROOT, "public", "assets", "one-shot.js"), "utf8");
const $ = cheerio.load(homepage);
const card = $(".arcade-card");
const svg = card.find("svg.arcade-board");

test("the card carries a picture of the game, drawn in the page rather than fetched", () => {
    assert.equal(svg.length, 1, `expected one illustration, found ${svg.length}`);
    assert.equal(card.find("img").length, 0, "the card fetches an image");
    assert.equal(svg.find("image").length, 0, "the illustration embeds a bitmap");
    assert.equal(svg.find("script").length, 0, "the illustration carries script");
    // Nothing in it may reach the network: an external reference in an SVG is a request this page
    // does not make today and a tracking vector it has never had.
    assert.ok(!/(?:href|src)\s*=\s*"(?:https?:)?\/\//i.test(svg.toString()), "the illustration references something off-page");
});

test("the picture is named, for a reader who cannot see it", () => {
    const title = svg.find("title").first().text().trim();
    assert.equal(svg.attr("role"), "img");
    assert.ok(title.length > 20, `the illustration's title is "${title}"`);
    assert.match(title, /scope/i, "the title does not say it is seen through the scope");
    assert.match(title, /courier/i, "the title does not name the courier");
    assert.match(title, /armed|gun/i, "the title does not name the armed threat");
});

test("every colour in the picture is one the game draws with", () => {
    const markup = svg.toString();
    const colours = [...new Set([...markup.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map(m => m[0]))];
    assert.ok(colours.length >= 10, `expected the game's palette, found ${colours.join(", ")}`);
    for (const colour of colours) {
        assert.ok(game.includes(`'${colour}'`), `the picture uses ${colour}, which one-shot.js never draws with`);
    }
    assert.ok(!/var\(--/.test(markup), "the picture borrows the site's palette instead of the game's");
});

test("the picture shows what the game is about: the courier's case, the armed man, the scope", () => {
    const markup = svg.toString();
    // The colour each is drawn in by one-shot.js, so a recolour there fails here until the card follows.
    const roles: Array<[string, string, RegExp]> = [
        ["the courier's red case", "#d63737", /fillStyle='#d63737';ctx\.fillRect\(10,-9,21,17\)/],
        ["the crowd", "#081018", /ctx\.fillStyle='#081018';ctx\.strokeStyle='#081018'/],
        ["the armed hostile's laser", "#ef4a4f", /ctx\.fillStyle='#ef4a4f'/],
        ["the scope's ring", "#020608", /ctx\.strokeStyle='#020608'/],
        ["the reticle's dot", "#f0444b", /ctx\.fillStyle='#f0444b'/]
    ];
    for (const [role, colour, drawn] of roles) {
        assert.match(game, drawn, `one-shot.js no longer draws ${role} in ${colour}`);
        assert.ok(markup.includes(`"${colour}"`), `the picture has no ${role}`);
    }
    // One courier and one gun: the game has exactly one hostile per contract.
    assert.equal(svg.find('rect[fill="#d63737"][width="21"]').length, 1, "the picture needs exactly one courier");
    assert.equal(svg.find('circle[fill="#ef4a4f"]').length, 1, "the picture needs exactly one raised gun");
    assert.ok(svg.find('g[transform*="scale"]').length >= 6, "a crowd is more than a few people");
});

test("the homepage still loads none of the game's code", () => {
    assert.ok(!homepage.includes("one-shot.js"), "the homepage loads one-shot.js");
    assert.equal($("canvas").length, 0, "the homepage has a canvas");
});

test("the card names the game and says the thing that makes someone press the button", () => {
    assert.equal(card.find(".arcade-name").text().trim(), ONE_SHOT_NAME);
    const words = card.find(".arcade-line").text().replace(/\s+/g, " ").trim();
    assert.match(words, /courier/i, `the copy does not say what you do: "${words}"`);
    assert.match(words, /in this page|in your browser/i, `the copy does not say where it runs: "${words}"`);
    assert.match(words, /free/i, `the copy does not say it is free: "${words}"`);
    assert.match(words, /no account/i, `the copy does not say it needs no account: "${words}"`);
    assert.equal(card.find("a.arcade-play").attr("href"), "/play/");
    assert.ok(!/RESET\/\/SCOPE/.test(homepage), "the homepage still names the old game");
});

test("nothing is claimed about a player who has not played", () => {
    const row = $("#arcade-records");
    assert.equal(row.length, 1);
    assert.notEqual(row.attr("hidden"), undefined, "the records line ships visible");
    // The tracker grid's tiles are not borrowed here: that is what made the card read as data.
    assert.equal(card.find(".record").length, 0, "the card uses the tracker grid's record tiles");
    assert.equal(card.attr("data-achievement-ids"), undefined, "RESET//SCOPE's achievement list is still on the card");
});

// === the records, painted by the real app.js ===

const RECORD_IDS = ["arcade-contract", "arcade-rank", "arcade-xp", "arcade-stars"];

function paintWith(shot: Record<string, unknown> | null) {
    const context: Record<string, any> = { console, setInterval: () => 0, clearTimeout: () => undefined, setTimeout: () => 0 };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8"), context, { filename: "app.js" });
    const nodes: Record<string, { textContent: string; hidden: boolean }> = {};
    for (const id of ["arcade-records", ...RECORD_IDS]) nodes[id] = { textContent: "", hidden: id === "arcade-records" };
    context.document = { getElementById: (id: string) => nodes[id] ?? null, querySelector: () => null };
    context.window = { NextResetPlayer: shot ? { oneShot: () => shot } : undefined };
    context.paintArcadeCard();
    return nodes;
}

const RETURNING = { contracts: 80, unlocked: 34, stars: [], starsTotal: 37, cleared: 33, bestScore: 0, xp: 18240, rank: "Marksman" };

test("a returning player sees the contract they resume at, their rank, XP and stars", () => {
    const nodes = paintWith(RETURNING);
    assert.equal(nodes["arcade-records"].hidden, false);
    assert.equal(nodes["arcade-contract"].textContent, "34/80");
    assert.equal(nodes["arcade-rank"].textContent, "Marksman");
    assert.equal(nodes["arcade-xp"].textContent, (18240).toLocaleString());
    assert.equal(nodes["arcade-stars"].textContent, "37/240", "three stars a contract, eighty contracts");
});

test("XP alone is not progress: carried XP with no contract cleared keeps the line hidden", () => {
    // A visitor can hold XP from before ONE SHOT. "Contract 1/80, 0/240" would be an empty form, not a record.
    const nodes = paintWith({ ...RETURNING, unlocked: 1, starsTotal: 0, cleared: 0, xp: 320, rank: "Recruit" });
    assert.equal(nodes["arcade-records"].hidden, true);
    assert.equal(nodes["arcade-contract"].textContent, "", "nothing was written into the hidden line");
});

test("without the player record the card stays as it shipped", () => {
    const nodes = paintWith(null);
    assert.equal(nodes["arcade-records"].hidden, true);
});

test("the records line names every field the script fills, and no more", () => {
    const ids = $("#arcade-records [id]").map((_, el) => $(el).attr("id")).get().sort();
    assert.deepEqual(ids, [...RECORD_IDS].sort());
    const app = fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8");
    for (const id of ids) {
        assert.ok(app.includes(`'${id}'`), `app.js never fills #${id}`);
    }
});
