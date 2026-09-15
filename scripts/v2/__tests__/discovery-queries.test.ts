import test from "node:test";
import assert from "node:assert/strict";
import { buildQueries, fillTemplate, nextVersion, versionOf } from "../discovery/queries";
import { formatQuery } from "../discovery/search-provider";
import { lolGame } from "./discovery-fixtures";

test("version arithmetic keeps the label's shape", () => {
    assert.equal(nextVersion("26.18"), "26.19");
    assert.equal(nextVersion("Patch 26.9"), "26.10");
    assert.equal(nextVersion("13.05"), "13.06");
    assert.equal(nextVersion("Update 43.1: Sunlit Skies"), "43.2");
    assert.equal(nextVersion("Season 05"), undefined);
    assert.equal(nextVersion(undefined), undefined);
    assert.equal(versionOf("Patch 26.18 notes"), "26.18");
    assert.equal(versionOf("Weekly reset"), undefined);
});

test("templates are filled deterministically and skipped when a placeholder is unknown", () => {
    const game = lolGame();
    const topic = game.topics[0];
    assert.equal(fillTemplate("{game} patch schedule", { game, topic }), "League of Legends patch schedule");
    assert.equal(fillTemplate("{game} patch {next}", { game, topic, latestLabel: "26.18" }), "League of Legends patch 26.19");
    assert.equal(fillTemplate("{game} patch {latest}", { game, topic, latestLabel: "Patch 26.18" }), "League of Legends patch 26.18");
    assert.equal(fillTemplate("{game} patch {next}", { game, topic }), undefined, "no known version, no query");
});

test("site-restricted queries come first, one per official domain, then the open ones", () => {
    const game = lolGame();
    const built = buildQueries({ game, topic: game.topics[0], latestLabel: "26.18" });
    assert.deepEqual(built.official.map(formatQuery), [
        "site:riotgames.com League of Legends patch schedule",
        "site:leagueoflegends.com League of Legends patch schedule",
        "site:riotgames.com League of Legends patch notes",
        "site:leagueoflegends.com League of Legends patch notes",
        "site:riotgames.com League of Legends patch 26.19",
        "site:leagueoflegends.com League of Legends patch 26.19"
    ]);
    assert.deepEqual(built.open.map(formatQuery), [
        "League of Legends patch schedule",
        "League of Legends patch notes",
        "League of Legends patch 26.19"
    ]);

    // Without a known version the {next} template is dropped; without templates the topic type is used.
    const fresh = buildQueries({ game, topic: game.topics[0] });
    assert.equal(fresh.open.length, 2);
    const plain = buildQueries({ game: lolGame({ discovery: { officialDomains: [] } }), topic: { ...game.topics[0], discovery: undefined } });
    assert.deepEqual(plain.official, []);
    assert.deepEqual(plain.open.map(q => q.text), ["League of Legends next patch"]);
});
