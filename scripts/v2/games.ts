/**
 * Static game configuration for the trackers on the V2 pipeline.
 *
 * Only GTA Online (weekly reset) and Roblox (status) are configured in this PR.
 * Ids, types, titles, source URLs and confidence labels match the V1 providers
 * so the published `/data/<game>.<type>.json` files keep their contract.
 */
import { Confidence } from "../types";
import { Adapter } from "./adapter";
import { createAiDiscoveryAdapter } from "./adapters/ai-discovery";
import { gtaWeeklyResetAdapter } from "./adapters/gta";
import { createRobloxStatusAdapter } from "./adapters/roblox";
import { Game, Topic } from "./domain";

/** The V1 League of Legends URL (now redirects to support.riotgames.com); kept as the configured known source. */
export const LOL_PATCH_SCHEDULE_URL = "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/360018987893-League-of-Legends-Patch-Schedule";

export const GAMES: Game[] = [
    {
        id: "lol",
        name: "League of Legends",
        slug: "lol",
        sources: [
            { id: "lol-patch-schedule", url: LOL_PATCH_SCHEDULE_URL, kind: "html" }
        ],
        topics: [
            {
                game: "lol",
                type: "next-patch",
                kind: "version",
                sourceId: "lol-patch-schedule",
                view: {
                    title: "League of Legends Next Patch",
                    sourceUrl: LOL_PATCH_SCHEDULE_URL,
                    confidence: Confidence.High,
                    notes: "Patch {label}"
                },
                discovery: {
                    queries: ["{game} patch schedule", "{game} patch notes", "{game} patch {next}"],
                    terms: ["patch schedule"],
                    answeredWhen: "future-scheduled"
                }
            }
        ],
        discovery: {
            officialDomains: ["riotgames.com", "leagueoflegends.com"],
            sitemapHosts: ["support.riotgames.com"],
            seeds: ["https://www.leagueoflegends.com/en-us/news/tags/patch-notes/"]
        }
    },
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

export const LOL_NEXT_PATCH_SPEC = {
    description: "the scheduled release date of each League of Legends patch (version numbers like 26.19), especially the next one",
    docTypes: ["patch-schedule", "patch-notes"] as const,
    itemKinds: ["version"] as const
};

const ADAPTERS: Record<string, Adapter> = {
    "lol/next-patch": createAiDiscoveryAdapter({ description: LOL_NEXT_PATCH_SPEC.description, docTypes: [...LOL_NEXT_PATCH_SPEC.docTypes], itemKinds: [...LOL_NEXT_PATCH_SPEC.itemKinds] }),
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
