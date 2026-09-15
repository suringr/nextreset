/**
 * Counter-Strike 2 updates, read from Steam news (see steam-news.ts).
 *
 * Source: the Steam Web API news endpoint for app 730, filtered by Steam itself
 * to Valve's community announcements tagged as patch notes. Valve announces every
 * live game update in a post titled exactly "Counter-Strike 2 Update"; beta,
 * pre-release, armory and store posts use other titles and are ignored.
 *
 * Identity is Steam's post id, and the instant is the post's publication time,
 * exact to the second. (V1 read a date-only value from counter-strike.net and
 * published midnight UTC of that day.)
 */
import { Adapter } from "../adapter";
import { Transport } from "../fetch/transport";
import { SteamNewsSpec, SteamPost, createSteamNewsAdapter, parseSteamNews } from "./steam-news";

export const CS2_NEWS_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=20&maxlength=240&feeds=steam_community_announcements&tags=patchnotes";

/** Where visitors are sent when a post carries no usable link of its own. */
export const CS2_UPDATES_PAGE = "https://www.counter-strike.net/news/updates";

export const CS2_STEAM_SPEC: SteamNewsSpec = {
    feed: "steam_community_announcements",
    requireTag: "patchnotes",
    title: /^counter-strike 2 update$/i,
    identity: "gid",
    fallbackUrl: CS2_UPDATES_PAGE,
    noPostReason: "no \"Counter-Strike 2 Update\" post among the latest Steam patch-note announcements"
};

/** Live update posts in a news API response, newest first. Throws when the response is not the news API shape. */
export function parseSteamUpdates(text: string): SteamPost[] {
    return parseSteamNews(text, CS2_STEAM_SPEC);
}

export function createCs2UpdatesAdapter(transport?: Transport): Adapter {
    return createSteamNewsAdapter(CS2_STEAM_SPEC, transport);
}
