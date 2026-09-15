import { Confidence } from "../../types";
import { Game, Topic } from "../domain";

export const LOL_SCHEDULE_URL = "https://support.riotgames.com/en-us/league-of-legends/gameplay/patch-schedule-league-of-legends";
export const LOL_NOTES_LISTING_URL = "https://www.leagueoflegends.com/en-us/news/tags/patch-notes";

/** A League of Legends configuration for discovery tests (the production one arrives with the vertical slice). */
export function lolGame(overrides: Partial<Game> = {}): Game {
    const topic: Topic = {
        game: "lol",
        type: "next-patch",
        kind: "version",
        sourceId: "lol-patch-schedule",
        view: { title: "League of Legends Next Patch", sourceUrl: LOL_SCHEDULE_URL, confidence: Confidence.High },
        discovery: { queries: ["{game} patch schedule", "{game} patch notes", "{game} patch {next}"], terms: ["patch schedule"] }
    };
    return {
        id: "lol",
        name: "League of Legends",
        slug: "lol",
        sources: [{ id: "lol-patch-schedule", url: LOL_SCHEDULE_URL, kind: "html" }],
        topics: [topic],
        discovery: {
            officialDomains: ["riotgames.com", "leagueoflegends.com"],
            sitemapHosts: ["support.riotgames.com"],
            seeds: [`${LOL_NOTES_LISTING_URL}/`]
        },
        ...overrides
    };
}
