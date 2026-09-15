/**
 * EA SPORTS FC last title update, read from Steam news (see steam-news.ts).
 *
 * Source: the Steam Web API news endpoint for each EA SPORTS FC title year, restricted to EA's community
 * announcements. EA announces title updates there with a marked version number in the title, in several forms:
 * "EA SPORTS FC 26 version 1.6.5", "EA SPORTS FC 26 v1.6.2", "FC 26 v1.5.3 Update", "EA SPORTS FC 26 Title Update 1.4.2",
 * "FC 26 Holiday Update (v1.3.0)", "EA SPORTS FC 26 - Version 1.0.2 Update Notes". The number must follow "v", "version"
 * or "update", so a bare number is not read as a version. Monthly "Feedback Update" posts, unversioned updates
 * ("Match Outcomes Update") and posts naming another title year (cross-posted into this app) are ignored.
 *
 * Each title year is its own Steam app, so the topic reads one feed per year, newest first, and combines them.
 * Identity is the year plus the version ("fc26-1.5.3"). The view publishes the newest title update across the
 * years: the previous year's last update until the new year's first one is posted, which then wins by date.
 *
 * The instant is the post's publication time, exact to the second: when the notes were published, which can precede
 * the patch reaching every platform. The EA Forums (the V1 source) answer with a Cloudflare challenge and are not used.
 *
 * Maintenance: add the next title year's app to EAFC_TITLE_YEARS when EA announces it.
 */
import { Adapter } from "../adapter";
import { Transport } from "../fetch/transport";
import { SteamNewsSpec, SteamPost, createSteamNewsFeedsAdapter, parseSteamNews } from "./steam-news";

/** The official game page, used when a post carries no link of its own. */
export const EAFC_PAGE = "https://www.ea.com/games/ea-sports-fc";

export interface EafcTitleYear {
    /** Two-digit title year, e.g. 26 for EA SPORTS FC 26. */
    year: number;
    /** The title's Steam app id. */
    appId: number;
}

/** Title years, newest first. */
export const EAFC_TITLE_YEARS: readonly EafcTitleYear[] = [
    { year: 27, appId: 4080220 },
    { year: 26, appId: 3405690 }
];

export function eafcSourceId(year: number): string {
    return `eafc-steam-fc${year}`;
}

export function eafcNewsUrl(appId: number): string {
    return `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=100&maxlength=240&feeds=steam_community_announcements`;
}

/** A versioned title update post for that title year; capture group 1 is the version. */
export function eafcTitlePattern(year: number): RegExp {
    return new RegExp(`^(?!.*feedback)(?=.*\\bFC(?:™)?\\s*${year}\\b).*?(?:\\bv|\\bversion\\s+|\\bupdate\\s+)(\\d+\\.\\d+(?:\\.\\d+)?)\\b`, "i");
}

export function eafcSpec(year: number): SteamNewsSpec {
    return {
        feed: "steam_community_announcements",
        title: eafcTitlePattern(year),
        identity: "title",
        identityPrefix: `fc${year}-`,
        fallbackUrl: EAFC_PAGE,
        noPostReason: "no versioned title update post among the latest 100 EA SPORTS FC Steam announcements"
    };
}

/** Title update posts for one title year, newest first. Throws when the response is not the news shape. */
export function parseEafcTitleUpdates(text: string, year: number): SteamPost[] {
    return parseSteamNews(text, eafcSpec(year));
}

export function createEafcTitleUpdateAdapter(transport?: Transport): Adapter {
    return createSteamNewsFeedsAdapter(EAFC_TITLE_YEARS.map(t => ({ sourceId: eafcSourceId(t.year), spec: eafcSpec(t.year) })), transport);
}
