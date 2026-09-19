/**
 * The homepage's arcade card: it has to read as the game it opens, and it is the approved demo's card.
 *
 * V4's correction round found a card that said nothing about being playable and gave it a picture of the
 * board. The demo — the visual source of truth since — has no picture: its arcade card is a violet-lit
 * panel with the game's name, one line, the player's records as small tiles, and a large PLAY NOW. That
 * is the card now, with ONE SHOT's name and words in it.
 *
 * What did not change is what the card may claim. The records are shown only once a contract has been
 * cleared — the demo shows a score of 0 to a visitor who has never played, and the site does not.
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
const $ = cheerio.load(homepage);
const card = $(".arcade-card");

test("the card is the demo's: copy on one side, one call to play on the other, and no picture", () => {
    assert.equal(card.length, 1);
    assert.equal(card.children(".arcade-copy").length, 1, "the copy column is missing");
    assert.equal(card.children(".arcade-cta").length, 1, "the play column is missing");
    assert.equal(card.find("svg, img, canvas").length, 0, "the card carries a picture the demo does not have");
    const play = card.find("a.arcade-play");
    assert.equal(play.length, 1);
    assert.ok(play.hasClass("btn") && play.hasClass("btn-primary"), "PLAY NOW is not the demo's primary button");
    assert.equal(card.find(".arcade-note").text().trim(), "Optimized for touch + desktop");
});

test("the records are the demo's tiles, one fact to a tile", () => {
    const tiles = $("#arcade-records > li");
    assert.equal(tiles.length, 4);
    tiles.each((_, li) => {
        assert.equal($(li).children("small").length, 1, "a tile has no label");
        assert.equal($(li).children("b").length, 1, "a tile has no value");
    });
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
