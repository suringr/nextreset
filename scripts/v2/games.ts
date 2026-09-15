/**
 * Static game configuration for the trackers on the V2 pipeline.
 *
 * Games migrated so far: League of Legends (next patch, evidence-based), Counter-Strike 2 (last update,
 * Steam news API), PUBG (last patch, Steam news API), VALORANT (last patch, playvalorant.com page data),
 * Warzone (last patch day, callofduty.com patch notes), Genshin Impact (current banner end, regional announcement
 * lists), EA SPORTS FC (last title update, Steam news per title year), Minecraft (last Java Edition release, Mojang
 * manifest), GTA Online (weekly reset rule) and Roblox (status feed).
 * Ids, types, titles, source URLs and confidence labels match the V1 providers
 * so the published `/data/<game>.<type>.json` files keep their contract.
 */
import { Confidence } from "../types";
import { Adapter } from "./adapter";
import { createAiDiscoveryAdapter } from "./adapters/ai-discovery";
import { gtaWeeklyResetAdapter } from "./adapters/gta";
import { CS2_NEWS_URL, CS2_UPDATES_PAGE, createCs2UpdatesAdapter } from "./adapters/cs2";
import { MINECRAFT_CHANGELOGS_PAGE, MINECRAFT_MANIFEST_URL, createMinecraftJavaAdapter } from "./adapters/minecraft-java";
import { PUBG_NEWS_URL, PUBG_PATCH_NOTES_PAGE, createPubgPatchAdapter } from "./adapters/pubg";
import { VALORANT_PATCH_NOTES_URL, createValorantPatchAdapter } from "./adapters/valorant";
import { WARZONE_PATCH_NOTES_URL, createWarzonePatchAdapter } from "./adapters/warzone";
import { GENSHIN_NEWS_PAGE, GENSHIN_REGIONS, createGenshinWishAdapter, genshinAnnouncementsUrl, genshinSourceId } from "./adapters/genshin";
import { EAFC_PAGE, EAFC_TITLE_YEARS, createEafcTitleUpdateAdapter, eafcNewsUrl, eafcSourceId } from "./adapters/eafc";
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
        id: "cs2",
        name: "Counter-Strike 2",
        slug: "cs2",
        sources: [
            // Steam Web API news for app 730, filtered by Steam to Valve's patch-note announcements (see adapters/cs2.ts).
            { id: "cs2-steam-patchnotes", url: CS2_NEWS_URL, kind: "json" }
        ],
        topics: [
            {
                game: "cs2",
                type: "last-update",
                kind: "occurrence",
                sourceId: "cs2-steam-patchnotes",
                view: {
                    title: "Counter-Strike 2 Last Update",
                    sourceUrl: CS2_UPDATES_PAGE,
                    confidence: Confidence.High,
                    notes: "{label}"
                }
            }
        ]
    },
    {
        id: "minecraft",
        name: "Minecraft",
        slug: "minecraft",
        sources: [
            // Mojang's launcher version manifest: latest.release and its exact releaseTime (see adapters/minecraft-java.ts).
            { id: "minecraft-java-manifest", url: MINECRAFT_MANIFEST_URL, kind: "json" }
        ],
        topics: [
            {
                game: "minecraft",
                type: "last-release",
                kind: "version",
                sourceId: "minecraft-java-manifest",
                view: {
                    title: "Minecraft Last Release",
                    sourceUrl: MINECRAFT_CHANGELOGS_PAGE,
                    confidence: Confidence.High,
                    notes: "Java Edition {label}",
                    // The evidence is the manifest's JSON entry; visitors keep the official changelogs page.
                    linkEvidence: false
                }
            }
        ]
    },
    {
        id: "pubg",
        name: "PUBG",
        slug: "pubg",
        sources: [
            // Steam Web API news for app 578080, the publisher's community announcements (see adapters/pubg.ts).
            { id: "pubg-steam-announcements", url: PUBG_NEWS_URL, kind: "json" }
        ],
        topics: [
            {
                game: "pubg",
                type: "last-patch",
                kind: "version",
                sourceId: "pubg-steam-announcements",
                view: {
                    title: "PUBG Last Patch",
                    sourceUrl: PUBG_PATCH_NOTES_PAGE,
                    confidence: Confidence.High,
                    notes: "{label}"
                }
            }
        ]
    },
    {
        id: "valorant",
        name: "VALORANT",
        slug: "valorant",
        sources: [
            // The official patch notes tag page; its Next.js page data lists the patch notes cards (see adapters/valorant.ts).
            { id: "valorant-patch-notes-page", url: VALORANT_PATCH_NOTES_URL, kind: "html" }
        ],
        topics: [
            {
                game: "valorant",
                type: "last-patch",
                kind: "version",
                sourceId: "valorant-patch-notes-page",
                view: {
                    title: "VALORANT Last Patch",
                    sourceUrl: VALORANT_PATCH_NOTES_URL,
                    confidence: Confidence.High,
                    notes: "{label}"
                }
            }
        ]
    },
    {
        id: "warzone",
        name: "Call of Duty: Warzone",
        slug: "warzone",
        sources: [
            // The official Call of Duty patch notes page; the Warzone card's data-date is the last update day (see adapters/warzone.ts).
            { id: "warzone-patch-notes-page", url: WARZONE_PATCH_NOTES_URL, kind: "html" }
        ],
        topics: [
            {
                game: "warzone",
                type: "last-patch",
                kind: "occurrence",
                sourceId: "warzone-patch-notes-page",
                view: {
                    title: "Call of Duty Warzone Last Patch",
                    sourceUrl: WARZONE_PATCH_NOTES_URL,
                    confidence: Confidence.High,
                    notes: "{label}"
                }
            }
        ]
    },
    {
        id: "genshin",
        name: "Genshin Impact",
        slug: "genshin",
        // One official announcement list per server region; each states its own UTC offset (see adapters/genshin.ts).
        sources: GENSHIN_REGIONS.map(({ region }) => ({ id: genshinSourceId(region), url: genshinAnnouncementsUrl(region), kind: "json" as const })),
        topics: [
            {
                game: "genshin",
                type: "next-banner",
                kind: "occurrence",
                sourceId: genshinSourceId("os_asia"),
                view: {
                    title: "Genshin Impact Next Banner End",
                    sourceUrl: GENSHIN_NEWS_PAGE,
                    confidence: Confidence.High,
                    notes: "{label}",
                    // The evidence is the announcement JSON; visitors keep the official news page.
                    linkEvidence: false
                }
            }
        ]
    },
    {
        id: "ea-sports-fc",
        name: "EA SPORTS FC",
        slug: "ea-sports-fc",
        // One Steam news feed per title year, newest first (see adapters/eafc.ts).
        sources: EAFC_TITLE_YEARS.map(t => ({ id: eafcSourceId(t.year), url: eafcNewsUrl(t.appId), kind: "json" as const })),
        topics: [
            {
                game: "ea-sports-fc",
                type: "last-title-update",
                kind: "version",
                sourceId: eafcSourceId(EAFC_TITLE_YEARS[0].year),
                view: {
                    title: "EA SPORTS FC Last Title Update",
                    sourceUrl: EAFC_PAGE,
                    confidence: Confidence.High,
                    notes: "{label}"
                }
            }
        ]
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
    "cs2/last-update": createCs2UpdatesAdapter(),
    "minecraft/last-release": createMinecraftJavaAdapter(),
    "pubg/last-patch": createPubgPatchAdapter(),
    "valorant/last-patch": createValorantPatchAdapter(),
    "warzone/last-patch": createWarzonePatchAdapter(),
    "genshin/next-banner": createGenshinWishAdapter(),
    "ea-sports-fc/last-title-update": createEafcTitleUpdateAdapter(),
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
