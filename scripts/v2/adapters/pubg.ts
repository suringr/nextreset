/**
 * PUBG last patch, read from Steam news (see steam-news.ts).
 *
 * Source: the Steam Web API news endpoint for app 578080, restricted to the
 * publisher's community announcements. Each game update is announced in a post
 * titled exactly "Patch Notes - Update <version>" (for example
 * "Patch Notes - Update 43.1"). Map service reports, store updates, event and
 * esports posts use other titles and are ignored. Steam's "patchnotes" tag has
 * not been used for PUBG since 2018, so it is not required.
 *
 * Esports and store posts are frequent, so the request asks for the latest 100
 * announcements (about three and a half months, several monthly patches); the
 * latest 20 had held only one patch post.
 *
 * Identity is the update version, and the instant is the post's publication
 * time, exact to the second. Since the 2025 console service change, one post
 * covers PC and console. (V1 read a date-only value from pubg.com and published
 * midnight UTC of that day.)
 */
import { Adapter } from "../adapter";
import { Transport } from "../fetch/transport";
import { SteamNewsSpec, SteamPost, createSteamNewsAdapter, parseSteamNews } from "./steam-news";

export const PUBG_NEWS_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=578080&count=100&maxlength=240&feeds=steam_community_announcements";

/** Where visitors are sent when a post carries no usable link of its own. */
export const PUBG_PATCH_NOTES_PAGE = "https://pubg.com/en/news?category=patch_notes";

export const PUBG_STEAM_SPEC: SteamNewsSpec = {
    feed: "steam_community_announcements",
    title: /^Patch Notes - Update (\d+\.\d+)$/,
    identity: "title",
    fallbackUrl: PUBG_PATCH_NOTES_PAGE,
    noPostReason: "no \"Patch Notes - Update\" post among the latest 100 PUBG Steam announcements"
};

/** Patch notes posts in a news API response, newest first, one per version. Throws when the response is not the news shape. */
export function parsePubgPatches(text: string): SteamPost[] {
    return parseSteamNews(text, PUBG_STEAM_SPEC);
}

export function createPubgPatchAdapter(transport?: Transport): Adapter {
    return createSteamNewsAdapter(PUBG_STEAM_SPEC, transport);
}
