/**
 * Static game configuration for the trackers on the V2 pipeline.
 *
 * Only GTA Online (weekly reset) and Roblox (status) are configured in this PR.
 * Ids, types, titles, source URLs and confidence labels match the V1 providers
 * so the published `/data/<game>.<type>.json` files keep their contract.
 */
import { Confidence } from "../types";
import { Adapter } from "./adapter";
import { gtaWeeklyResetAdapter } from "./adapters/gta";
import { createRobloxStatusAdapter } from "./adapters/roblox";
import { Game, Topic } from "./domain";

export const GAMES: Game[] = [
    {
        id: "gta",
        name: "GTA Online",
        slug: "gta",
        sources: [
            { id: "gta-weekly-reset-rule", url: "https://www.rockstargames.com/gta-online", kind: "rule" }
        ],
        topics: [
            {
                game: "gta",
                type: "weekly-reset",
                kind: "recurring",
                sourceId: "gta-weekly-reset-rule",
                view: {
                    title: "GTA Online Weekly Reset",
                    sourceUrl: "https://www.rockstargames.com/gta-online",
                    confidence: Confidence.High,
                    notes: "Weekly reset occurs every Thursday at 10:00 UTC"
                }
            }
        ]
    },
    {
        id: "roblox",
        name: "Roblox",
        slug: "roblox",
        sources: [
            // Plain http, as in V1; the feed does not redirect and the site link shown to visitors is https.
            { id: "roblox-hostedstatus", url: "http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d", kind: "json" }
        ],
        topics: [
            {
                game: "roblox",
                type: "status",
                kind: "occurrence",
                sourceId: "roblox-hostedstatus",
                view: {
                    title: "Roblox Service Status",
                    sourceUrl: "https://status.roblox.com",
                    confidence: Confidence.High,
                    notes: "Current status: {label}"
                }
            }
        ]
    }
];

const ADAPTERS: Record<string, Adapter> = {
    "gta/weekly-reset": gtaWeeklyResetAdapter,
    "roblox/status": createRobloxStatusAdapter()
};

export function findGame(gameId: string): Game {
    const game = GAMES.find(g => g.id === gameId);
    if (!game) throw new Error(`No V2 configuration for game ${JSON.stringify(gameId)}`);
    return game;
}

export function findTopic(game: Game, type: string): Topic {
    const topic = game.topics.find(t => t.type === type);
    if (!topic) throw new Error(`No V2 topic ${JSON.stringify(type)} for game ${game.id}`);
    return topic;
}

export function adapterFor(topic: Topic): Adapter {
    const adapter = ADAPTERS[`${topic.game}/${topic.type}`];
    if (!adapter) throw new Error(`No adapter registered for ${topic.game}/${topic.type}`);
    return adapter;
}
