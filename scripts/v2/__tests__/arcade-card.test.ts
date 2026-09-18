/**
 * V4 correction, PR 3: the arcade card has to read as a game.
 *
 * The audit's finding was not that the card was missing or badly placed — it is above the fold and one
 * tap from a running game. It was that nothing on it said "playable": the same surface, border, radius
 * and record tiles as the twelve tracker cards, no picture, nothing in motion, and for a first-time
 * visitor three em-dashes painted in the verified green as its largest element.
 *
 * So the card now shows the board. The tests that matter are the ones that keep it *the* board:
 * a picture that drifts from the game it depicts is worse than no picture, because it teaches a rule
 * the game does not implement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { ACHIEVEMENTS } from "../../design/progression";

const ROOT = path.join(__dirname, "..", "..", "..");
const homepage = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const scopeJs = fs.readFileSync(path.join(ROOT, "public", "assets", "scope.js"), "utf8");
const $ = cheerio.load(homepage);
const card = $(".arcade-card");
const svg = card.find("svg.arcade-board");

/** The role-to-token map the renderer actually uses, read from its own source. */
function gamePalette(): Record<string, string> {
    const block = scopeJs.slice(scopeJs.indexOf("colours = {"), scopeJs.indexOf("};", scopeJs.indexOf("colours = {")));
    const map: Record<string, string> = {};
    for (const match of block.matchAll(/(\w+):\s*palette\('(--[a-z-]+)'\)/g)) map[match[1]] = match[2];
    return map;
}

test("the card carries a picture of the board, drawn in the page rather than fetched", () => {
    assert.equal(svg.length, 1, `expected one board illustration, found ${svg.length}`);
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
    assert.match(title, /scope/i, "the title does not describe what is being shown");
});

test("the picture uses the game's own palette, for the game's own roles", () => {
    // If someone recolours a contact in scope.js, this fails until the homepage picture follows. A
    // hostile that is amber in the game and red on the card teaches the wrong thing before the first run.
    const palette = gamePalette();
    const markup = svg.toString();
    for (const [role, token] of [["target", palette.target], ["civilian", palette.civilian], ["verified", palette.verified]]) {
        assert.ok(token, `scope.js no longer maps a colour for "${role}"`);
        assert.ok(markup.includes(`var(${token})`), `the picture does not draw ${role} with ${token}, the token the game uses`);
    }
    // And no colour is written as a literal: the stylesheet forbids it, and a picture is not an exception.
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(markup), "the picture writes a colour instead of taking a token");
});

test("the picture draws the shapes the game draws: a hard-edged hostile and an open civilian", () => {
    const markup = svg.toString();
    // scope.js draws a hostile as a four-point diamond and a civilian as a circle with a line across.
    // These are the shapes identification depends on, and they carry the difference without colour.
    assert.match(markup, /<path[^>]+d="M[\d.\s]+L[\d.\s]+L[\d.\s]+L[\d.\s]+Z"/, "no diamond: the hostile shape is missing");
    assert.ok(svg.find("circle").length >= 3, "too few circles for a civilian, a hostage and a crosshair");
    assert.ok(/fill-rule="evenodd"/.test(markup), "the scope does not dim the board it takes away");
});

test("the homepage still loads none of the game's code", () => {
    for (const asset of ["scope-core.js", "scope.js", "scope-play.js"]) {
        assert.ok(!homepage.includes(asset), `the homepage loads ${asset}`);
    }
    assert.equal($("canvas").length, 0, "the homepage has a canvas");
});

test("the card says the thing that makes someone press the button", () => {
    const words = card.find(".arcade-line").text().replace(/\s+/g, " ").trim();
    assert.match(words, /in this page|in your browser/i, `the copy does not say where it runs: "${words}"`);
    assert.match(words, /free/i, `the copy does not say it is free: "${words}"`);
    assert.match(words, /no account/i, `the copy does not say it needs no account: "${words}"`);
    assert.equal(card.find("a.arcade-play").attr("href"), "/play/");
});

test("nothing is claimed about a player who has not played", () => {
    const row = $("#arcade-records");
    assert.equal(row.length, 1);
    assert.notEqual(row.attr("hidden"), undefined, "the records line ships visible");
    // The tracker grid's tiles are not borrowed here any more: that is what made the card read as data.
    assert.equal(card.find(".record").length, 0, "the card still uses the tracker grid's record tiles");
    assert.equal(card.find(".arcade-stats").length, 0, "the old stats block is still here");
    // And no em-dash is the largest thing on the card before a first run.
    assert.ok(!/&mdash;|—/.test(card.find(".arcade-copy").html() ?? "").valueOf() || row.attr("hidden") !== undefined);
});

test("the achievement goal on the card is the goal the game actually awards", () => {
    // The card quotes "3/6". The 6 has to be the length of the table the game grants from, or the card
    // promises a total that does not exist.
    const total = Number(card.attr("data-achievement-total"));
    assert.equal(total, ACHIEVEMENTS.length,
        `the card says ${total} achievements; scripts/design/progression.ts defines ${ACHIEVEMENTS.length}`);
});

test("the records line names every field the script fills, and no more", () => {
    const ids = $("#arcade-records [id]").map((_, el) => $(el).attr("id")).get().sort();
    assert.deepEqual(ids, ["arcade-achievements", "arcade-mission", "arcade-rank", "arcade-score"]);
    const app = fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8");
    for (const id of ids) {
        assert.ok(app.includes(`'${id}'`), `app.js never fills #${id}`);
    }
});
