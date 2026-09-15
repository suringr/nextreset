/**
 * Counter-Strike 2 updates (structured JSON source, deterministic parse).
 *
 * Source: the Steam Web API news endpoint for app 730, filtered by Steam itself
 * to Valve's community announcements tagged as patch notes. Valve announces every
 * live game update in a post titled exactly "Counter-Strike 2 Update"; beta,
 * pre-release, armory and store posts use other titles and are ignored.
 *
 * Each update post becomes one observed event. Identity is Steam's post id
 * (`gid`), and the instant is the post's publication time, exact to the second.
 * That is when Valve announced the update, which can differ slightly from when
 * it went live. (V1 read a date-only value from counter-strike.net and published
 * midnight UTC of that day.)
 *
 * Evidence: each post is recorded as a document whose URL is Steam's own link
 * for the post (it redirects to the community announcement), with one
 * deterministic claim quoting the API fields the instant came from, so the
 * published `source_url` points at the post itself.
 *
 * No model is involved: an unchanged response stops at the text hash, and a
 * changed one is parsed by code.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter, EventInput } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
import { eventKey } from "../identity";

export const CS2_NEWS_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=20&maxlength=240&feeds=steam_community_announcements&tags=patchnotes";

/** Where visitors are sent when a post carries no usable link of its own. */
export const CS2_UPDATES_PAGE = "https://www.counter-strike.net/news/updates";

const FEED = "steam_community_announcements";
const UPDATE_TITLE = /^counter-strike 2 update$/i;

export interface SteamUpdatePost {
    /** Steam's post id. */
    gid: string;
    title: string;
    /** Publication time as the API gives it (epoch seconds). */
    date: number;
    /** Publication instant, ISO 8601 UTC. */
    at: string;
    /** Steam's link for the post. */
    url: string;
}

/** Live update posts in a news API response, newest first. Throws when the response is not the news API shape. */
export function parseSteamUpdates(text: string): SteamUpdatePost[] {
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON in Steam news response");
    }
    const items = data?.appnews?.newsitems;
    if (!Array.isArray(items)) throw new Error("No appnews.newsitems in Steam news response");

    const posts: SteamUpdatePost[] = [];
    for (const item of items) {
        if (item?.feedname !== FEED) continue;
        if (!Array.isArray(item.tags) || !item.tags.includes("patchnotes")) continue;
        if (typeof item.title !== "string" || !UPDATE_TITLE.test(item.title.trim())) continue;
        if (typeof item.gid !== "string" || !/^\d+$/.test(item.gid)) continue;
        if (typeof item.date !== "number" || !Number.isInteger(item.date) || item.date <= 0) continue;
        posts.push({
            gid: item.gid,
            title: item.title.trim(),
            date: item.date,
            at: new Date(item.date * 1000).toISOString(),
            url: typeof item.url === "string" && /^https:\/\//i.test(item.url) ? item.url : CS2_UPDATES_PAGE
        });
    }
    return posts.sort((a, b) => b.date - a.date || (a.gid < b.gid ? 1 : -1));
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/** The document and claim behind one post's event. Ids are content-derived, so re-reading a post adds nothing. */
export function evidenceFor(post: SteamUpdatePost, gameId: string, topicType: string, sourceId: string, fetchedAt: string): { document: Document; claim: Claim } {
    const quote = JSON.stringify({ gid: post.gid, title: post.title, date: post.date });
    const documentId = sha(`steam-news|${quote}`);
    const key = eventKey(gameId, topicType, post.gid);
    return {
        document: { id: documentId, url: post.url, sourceId, fetchedAt, title: post.title, fetchMode: "http", confidence: Confidence.High },
        claim: { id: sha(`${documentId}|${key}|at|${post.at}`).slice(0, 24), documentId, eventKey: key, field: "at", value: post.at, method: "deterministic", quote, extractedAt: fetchedAt }
    };
}

/** `transport` is injectable for tests; production uses the default HTTP transport (no rendering for JSON). */
export function createCs2UpdatesAdapter(transport?: Transport): Adapter {
    return async ({ game, topic, now, getSourceState }) => {
        const source = game.sources.find(s => s.id === topic.sourceId);
        if (!source) throw new Error(`Source ${topic.sourceId} is not configured for ${game.id}`);

        // Validators and hashes belong to a URL: if the configured source moved, start from nothing.
        const stored = getSourceState(source.id);
        const previous = stored && stored.url === source.url ? stored : undefined;

        const fetched = await smartFetch(source.url, { expect: { kind: "json" }, allowRender: false, previous, transport, label: `${game.id}-${topic.type}`, now });
        const sourceStates: SourceState[] = [{ id: source.id, url: source.url, ...fetched.state }];
        if (fetched.outcome === "unusable") {
            return { events: [], failure: fetched.error ?? fetched.verdict?.reason ?? "fetch failed", sourceStates };
        }
        const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };
        if (fetched.outcome === "unchanged") {
            return { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 } };
        }

        // Content that cannot be trusted is a source failure. Keep the last good hash and drop validators, so the same
        // content is examined again next run instead of reading as "unchanged, still good".
        const reject = (verdict: string, reason: string) => {
            sourceStates[0] = {
                ...sourceStates[0],
                etag: undefined,
                lastModified: undefined,
                textHash: previous?.textHash,
                lastUsableAt: previous?.lastUsableAt,
                lastVerdict: verdict,
                consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
            };
            return { events: [], failure: reason, sourceStates };
        };
        let posts: SteamUpdatePost[];
        try {
            posts = parseSteamUpdates(fetched.document!.body);
        } catch (error) {
            return reject("parse-error", error instanceof Error ? error.message : String(error));
        }
        if (posts.length === 0) {
            // A valid response without any live update post among the latest patch-note posts: Valve may have changed
            // how updates are titled. Surface it as stale instead of quietly re-verifying the last update.
            return reject("no-update-posts", "no \"Counter-Strike 2 Update\" post among the latest Steam patch-note announcements");
        }

        const fetchedAt = fetched.document!.fetchedAt;
        const evidence = posts.map(p => evidenceFor(p, game.id, topic.type, source.id, fetchedAt));
        const events: EventInput[] = posts.map(p => ({ identity: p.gid, label: p.title, status: "observed", at: p.at, precision: "exact", timezone: "UTC" }));
        return {
            events,
            documents: evidence.map(e => e.document),
            claims: evidence.map(e => e.claim),
            confidence: Confidence.High,
            sourceStates,
            fetch,
            // Structured JSON parsed by code: never sent to a model.
            work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
        };
    };
}
